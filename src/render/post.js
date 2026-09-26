// src/render/post.js — the hand-rolled post-processing stack (CONTRACTS-RENDER.md §3.1).
//
// No EffectComposer, no three/addons: every pass below is written here against the
// vendored three.js r160 core. Pipeline, in order:
//
//   1. scene   -> HDR (half-float) target, MSAA-resolved, with a depth texture
//   2. SSAO    -> depth-derived normals, TWO hemisphere terms (tight contact x
//                 wide cavity), tangent-plane occluder gate (kills the
//                 grazing-angle false positive on flat ground), 4x4 ordered
//                 rotation, plane-predicting depth+normal bilateral denoise
//   3. lit     -> HDR * AO (one full-res multiply; also the AO debug tap)
//   4. bloom   -> soft-knee threshold + hue-preserving highlight clamp, 6-mip
//                 Karis downsample / tent upsample
//   5. DOF     -> tilt-shift CoC from depth (sky excluded), asymmetric near/far
//                 ramp, golden-angle bokeh gathered in PIXEL units + fill
//   6. grade   -> ACES (hue-preserving blend) + lift/gamma/gain, then a
//                 CHANNEL-SAFE contrast/saturation (see the grade block: no op
//                 may drive one channel to zero while its siblings survive),
//                 split-tone, depth desaturation (aerial perspective), vignette
//   7. sharpen -> AMD FidelityFX CAS  (BEFORE the AA resolve, see §"ordering")
//   8. AA      -> FXAA 3.11 quality preset 39 (on top of hardware MSAA)
//
// ordering: CAS runs *before* FXAA. Running it after re-hardens exactly the
// edges FXAA just resolved, which shows up as re-stepped silhouettes on
// high-contrast vertical tower edges. `sharpen.beforeAA = false` restores the
// old order for A/B.
//
// dither: the AO kernel rotation is a 4x4 ordered (Bayer) tile, and the AO
// denoise is a separable [1,2,2,2,1]/8 kernel — the mean of the two 4-wide
// boxes that straddle the centre texel, at a stride of exactly ONE texel.
// Four consecutive texels contain each of the four column phases of that row
// exactly once, so the horizontal pass leaves a value that depends only on the
// row phase; the vertical pass then averages the four row phases. The result is
// independent of both, i.e. the rotation cancels rather than being attenuated
// at some other frequency and then re-amplified by CAS.
//
// Measured on the reference city (hero shot, 2560x1440, quality 2), amplitude
// of the 1-texel-period component in the AO buffer (PM.aoDither):
//     raw (no denoise)                              7.80
//     stride 2 (parities never mix)                 5.59   (-28%)
//     stride 1, weights only (a plain Gaussian)     3.37   (-57%)
//     stride 1 + depth/normal bilateral (shipped)   2.19   (-72%)
// The bilateral is BETTER at cancelling the rotation than the Gaussian was, not
// worse: the taps it rejects are the cross-edge ones, where the raw AO differs
// most and the average was therefore least representative.
//
// Everything is procedural; no assets, no network. Works with the existing
// onBeforeCompile injections on the scene materials (we never touch materials).

import * as THREE from '../../vendor/three.module.js';

const clamp = THREE.MathUtils.clamp;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultParams() {
  return {
    ssao: {
      enabled: true,
      // Two multiplied terms. The wide one is the cavity/skylight term (street
      // canyons, courtyards); the tight one is CONTACT occlusion — the dark
      // seam where anything meets the ground. One radius cannot do both: at
      // 5.5 units the kernel steps straight over a 1-unit kerb and paints a
      // broad fake vignette up tall walls instead.
      // Tuned to ref04 (the Blender house): a SOFT gradient one-to-two voxels
      // deep in every inside corner, never a black ink line. The old contact
      // term (2.8 over 0.7 units) drew a 1-2 px near-black seam round every
      // base — read as a dirty outline, not light.
      // Round 2: catalog buildings are res-4 now (a voxel is 0.25 world
      // units), so the old 2.6 / 1.1 radii spanned 10 / 4 voxels and painted a
      // soft grey skirt onto open grass round every bush, lamp and car. ref04's
      // AO is one-to-two voxels deep and lives in the crease; the cavity term
      // is therefore tighter and gentler, and the contact term is shorter but
      // stronger so crevices (pilasters, sills, roof steps) still read crisply.
      // Round 5 (critic r4: "flat; almost no soft AO in inside corners, under
      // cornices, round rooftop AC units or where buildings meet their lots";
      // ref05 grades every block with deep soft AO). The voxel baked AO only
      // reaches ~1 voxel and never sees ANOTHER model (AC unit on a roof deck,
      // tower on its lot), so SSAO now applies to voxel pixels too
      // (voxelKeep 1, castGate 0) with a wider, darker cavity term and a
      // gentle canyon term. Measured iso-mid 8-bit luma p25/p50/p75:
      // 93/144/181 -> 59/126/176 (ref05 68/140/192); frame cost unchanged
      // within noise (sync'd 19.5 ms both at 2000x1125 internal).
      // Round 8 (critic r7: "dense AO pools under every ledge and cornice add
      // near-black mass"; ref05's AO is thin and soft): strength and radius
      // of every term roughly halved. Was 1.1 @ 2.0 / 2.0 @ 0.5 / canyon 0.4 @ 4
      // (voxel canyon 0.8).
      // Round 10 (critic r9: "near-black contact shadows and AO fill every gap
      // between towers; lighten the AO floor 20-30%"): every term x0.75.
      // Round 12 (critic r11: "AO reads as black grime in recesses instead of
      // ref04's soft gradients; contact shadows crush to near-black"): every
      // term ~x0.6 again. The grade's floor (below) now also lifts what is left.
      intensity: 0.26,        // wide cavity term  (0..2). r12: 0.41 -> 0.26. r10: 0.55 -> 0.41
      radius: 1.2,            // world units (tile = 8, building voxel = 0.25)
      contactIntensity: 0.42, // tight contact term. r12: 0.75 -> 0.42. r10: 1.0 -> 0.75
      contactRadius: 0.35,    // world units — ~1.5 building voxels
      bias: 0.025,            // view-space depth bias, kills self-occlusion acne
      // Tangent-plane gate (see occlude()). An occluder must rise this fraction
      // of the SAMPLE RADIUS above the centre fragment's own tangent plane
      // before it counts in full. This is what a depth bias cannot do: it is the
      // only test that can tell "a wall at my feet" from "the same flat ground I
      // am standing on, sampled along the view ray at a grazing angle". Set it
      // negative to disable the gate and reproduce the old grazing-angle false
      // positive for an A/B.
      //
      // The far-field fix is INSENSITIVE to this value (identical grass profile
      // at region for every planeBias in 0..0.4) because the uv snap makes the
      // coplanar rise exactly zero rather than merely small — this knob only
      // sets how softly the gate opens. It is therefore tuned down to where the
      // near-field contact peak is untouched: measured contact dip at hero,
      // gate off / 0.0 / 0.05 / 0.10 / 0.15 / 0.25 = 32.38 / 32.37 / 32.25 /
      // 31.94 / 31.32 / 28.94 %.
      planeBias: 0.05,
      castGate: 0.0,          // 1 = pixels with scene alpha < 1 (voxel, ssaoKeep 0) cast
                              // no SSAO either (surface r5). 0 since round 5: a
                              // voxel AC unit must darken the voxel roof it sits on.
      // surface r7 (integration, 1 value): 1.0 -> 0.0. Critic r6 picked the
      // reference over "smudgy dark halos along every silhouette and under
      // every ledge" on the bakery; A/B (surface r7-diag) shows they are this
      // screen-space term on voxel faces (gone with voxelKeep 0; baked
      // voxel.js ray AO already darkens every crease, lot contact included).
      // Voxels still CAST (castGate 0) onto terrain/roads.
      voxelKeep: 0.0,         // floor on the scene-alpha RECEIVE gate: 0 = honour
                              // materials.js ssaoKeep (voxel faces take no SSAO),
                              // 1 = every pixel takes the full SSAO (round 5)
      voxelCanyon: 0.18,      // r12: 0.3 -> 0.18. r10: 0.4 -> 0.3. r8: 0.8 -> 0.4. r6: voxel faces (gated out above) still take the CANYON
                            // term only — soft mass shading, no contact halos
      canyonIntensity: 0.1,   // r12: 0.15 -> 0.1. r10: 0.2 -> 0.15. r8: 0.4 -> 0.2. broad skylight term (street canyons, tower bases, lot
      canyonRadius: 4.0,      // edges); round 5, was off
      power: 1.0,             // contrast of the cavity curve
      contactPower: 1.0,      // contrast of the contact curve
      minPixels: 2.5,         // screen-space floor: contact stays resolvable far away
      maxPixels: 72,          // screen-space ceiling: no cache thrash up close
      tint: [1.0, 1.0, 1.0],  // neutral: a cool tint greys warm walls (dirty)
      chroma: 0.3,            // r11: 0.1 -> 0.3 (critic r10: "AO sits at a flat, greyed blue-grey"). occluded texels keep/boost saturation (ref04's
                              // corners go deeper orange, not grey)
      denoiseStride: 1,       // AO texels per denoise tap. MUST be 1 for the
                              // rotation to cancel; exposed only so the harness
                              // can reproduce the old checkerboard on demand.
      // Bilateral denoise guides. The filter reads the REAL depth texture (the
      // AO buffer is 8-bit and cannot carry a 0..far view distance — storing it
      // there clamped every non-sky texel to 1.0 and silently turned the
      // "bilateral" into a plain Gaussian that averaged unoccluded background
      // straight into the contact pixel).
      denoiseDepthSigma: 0.0045,  // tolerance as a FRACTION of view depth
      denoiseNormalPower: 6.0,    // silhouette/crease rejection sharpness
    },
    bloom: {
      enabled: true,
      // Night-only. The iso reference is a clean daylight render with no glow
      // at all, so daytime bloom is pure haze: it softened every lit window and
      // white roof into a halo. Strength is scaled by smoothstep(nightStart, nightFull, ctx.nightEff),
      // and at 0 the whole mip chain is skipped (saves ~0.4 ms by day).
      // night r1: 0.9 / 0.30 -> 0.8 / 0.38 — lit panes (HDR ~0.9-1.2) and
      // lamp heads now get a gentle halo, neon a clear one; still no haze.
      threshold: 0.8,
      softness: 0.6,      // soft-knee width as a fraction of threshold
      strength: 0.38,
      radius: 0.85,       // upsample tent spread
      clamp: 2.4,         // max pre-blur highlight magnitude (hue-preserving)
      nightOnly: true,
      nightStart: 0.18,   // nightEff where bloom begins to fade in
      nightFull: 0.6,     // ...and where it reaches full strength
    },
    // Tilt-shift DOF is OFF: the reference is orthographic and pin-sharp edge
    // to edge. The code is kept (quality 1/2 still allow it) so a photo-mode can
    // switch it back on with setParams({dof:{enabled:true}}).
    dof: {
      enabled: false,
      autoFocus: true,
      focus: 0,           // view-space distance to the focal plane (auto when 0)
      range: 0,           // depth over which CoC ramps to 1 (auto when 0)
      rangeScale: 1.15,   // auto range = camDist * rangeScale
      nearRatio: 0.5,
      strength: 1.0,
      maxBlur: 0.95,
      tilt: 0.62,
      tiltStart: 0.24,
      tiltEnd: 0.86,
      tiltCenter: 0.5,
      skyGuard: true,
    },
    // Aerial perspective (distance desaturation). Off: nothing recedes in the
    // reference, and at iso the "far" half of the frame is just the top half.
    atmo: { strength: 0.0, start: 0.35, rangeScale: 3.5 },
    grade: {
      // 'neutral' = Khronos PBR Neutral: identity below ~0.76, so authored
      // palette colours land on screen as authored and only highlights
      // compress (no clipped whites, no ACES hue skew / midtone loss).
      // 'aces' = the old hue-blended ACES fit (uses `punch`).
      tonemap: 'neutral',
      // Round 3: a later shoulder (0.90, was the fixed 0.76) takes the lit
      // faces (scene-linear 0.88-0.99) out of the compression band, where
      // top, left face and white trim had all been squeezed onto ~0.93.
      exposure: 1.0,
      shoulder: 0.90,
      saturation: 0.98,   // w2r1: 0.95 -> 0.98 (+ vibrance 0.12: the overview read pastel; frame sat 0.308 vs ref05 0.351 — vibrance lifts the muted faces, not the already-hot reds/blues). r12: 0.96 -> 0.95 (critic r11: roofs and the saturated blues/reds read noisy vs ref05's calm palette). r8: 1.0 -> 0.96 (critic r7: greens/pinks a touch hot vs ref05's pastels). r5: 1.05 -> 1.0 (critic r4: over-saturated, lime/cyan noise)
      contrast: 1.02,     // r12: 1.03 -> 1.02 only — a global cut lifts the roads (0.98 took asphalt 32 -> 43/255, same frame); the crush is fixed locally by grade.above + floor. r8: 1.08 -> 1.03 (1.08 pushed display 0.09 -> 0.057 and every shade face down with it). r5: 1.14 -> 1.08 — SSAO on buildings now carries the separation; 1.14 on top crushed p5 to 0.03
                          // luminance-only (ratio safe); value separation. r4: 1.08 -> 1.14 (critic: overview flatter than ref05)
      lift: 0.0,          // lift washes near-black asphalt to grey
      gamma: 1.0,
      gain: 1.0,
      vignette: 0.0,      // reference is evenly lit to the corners
      punch: 0.5,         // aces only: 0 = plain ACES, 1 = fully hue preserving
      warm: 0.02,         // warm highlights / cool shadows split-tone amount
      // Round 2 (critic: "muted and hazy", "shaded faces fall to charcoal").
      // Chroma-first: the lighting piece brightened its fill in the same
      // round, so exposure stays 1.0 and the lift is small — stacking both
      // washed the cream towers out. Measured iso-close grass #9db96b ->
      // #a3c666, asphalt unchanged (#1b1b1c).
      shadowLift: 0.0,    // luminance bump over display 0.11..0.78 (asphalt-safe).
                          // 0 since round 3: it lifted exactly the shaded faces
                          // the critic wanted darker.
      shadowSat: 0.2,     // r12: 0.32 -> 0.2 (saturated darks = the "dense" read; the floor now keeps shade faces light AND hued). r11: 0.22 -> 0.32 (critic r10: shade faces "flat, slightly greyed blue-grey"; ref05's dark faces are clean and saturated). r10: 0.1 -> 0.22 (critic r9: shaded right faces greyish/desaturated; the floor now lifts them, so chroma no longer reads navy). extra chroma over the shaded band. r8: 0.3 -> 0.1 (it pushed shade faces to navy/brown)
      vibrance: 0.12,     // w2r1: 0.05 -> 0.12. r8: 0.15 -> 0.05. saturation weighted toward muted colours (r5: 0.30 -> 0.15)
      greenLift: 0.10,    // luminance gain on yellow-green (grass, canopies)
      // Hue-preserving highlight shoulder in DISPLAY space, applied after the
      // grade's saturation/contrast so they cannot push a channel into a hard
      // clip: values above `knee` roll off smoothly to 1.0.
      knee: 0.94,         // r6: 0.96 -> 0.94 (critic r5: bright tops should roll off, not clip)
      // Display-space toe at the very end of the chain (after USM): lifts only
      // crushed blacks (y < end); asphalt ~0.1 is unchanged. Round 5.
      toe: { amount: 0.035, end: 0.12 },  // r7: 0.06/0.16 -> 0.035/0.12 (blackSlope now lifts the
                                          // darks WITH slope; this toe only catches true black).
                                          // r6: 0.035/0.14 -> 0.06/0.16: shaded asphalt
                                          // (light r5 open shadows) sat at 11-14/255; ref05's flat ~22
      // Round 3 (critic r2: "washed out, cream towers have nearly equal left
      // and right faces, needs a punchier midtone curve"). The curve (see the
      // composite) is an upper-mid DIP, not a pivot-0.5 S: an S compresses
      // exactly the 0.75-0.95 band where a lit cream wall and its shaded side
      // live. Measured iso-mid cream tower, 8-bit luma lit/shade (same frame,
      // lighting as of 11:40): old grade 233/191 (0.82) -> 232/162 (0.70);
      // ref05's cream tower ~218/160 (shade #a7a191). Frame p50 0.615 -> 0.54
      // (ref05 0.548); asphalt and glass (< dipStart) untouched.
      // Lighting was darkening its fill in the same round: a first version
      // tuned on the older, flatter lighting (gamma 1.3 + dip 0.09, exposure
      // 0.92) stacked with it to 0.65 and p50 0.46 — muddy. Re-tune HERE (not
      // in lighting) only if the frame p50 drifts off ~0.55.
      curve: {
        gamma: 0.82,      // r10: 0.88 -> 0.82 (critic r9: lift mid-tones; iso-mid p50 113 -> 137, ref05 140). top-anchored luma power (f(1)=1); 1 = off. r6: 1.0 -> 0.88
                          // (light r5 deepened fill/open shadows: live iso p50 0.47 vs ref05
                          // 0.55; gm < 1 lifts mids, the toe0..toe1 fade keeps asphalt put)
        toe0: 0.05, toe1: 0.3, // gamma fades to identity below toe0
        dip: 0.0,         // r6: 0.06 -> 0 (light now owns the lit/shade face split; the
                          // dip only stacked on it). r5: 0.11 -> 0.06 (SSAO darkens the shaded mids now; keeps p75 up)
                          // upper-mid dip depth: f = y - dip*6.75 u^2 (1-u)
        dipStart: 0.35,   // u = (y - dipStart)/(1 - dipStart); peak at y ~0.78
        sat: 0.7,         // r12: 1.1 -> 0.7. chroma returned to darkened pixels (no grey sides)
        green: 0.85,      // fraction of the curve lawn/foliage hues are spared
      },
      deepDark: 0.2,      // r6: neutral darks (asphalt) down/de-tinted, see composite
                          // (r7: low ramp 0.05..0.12 -> 0..0.04 — a uniform ratio, no flat band)
      // r7: PBR Neutral toe slope at black (0 = Khronos: zero slope, so shaded
      // asphalt and everything inside a cast shadow flattened to one ~15/255).
      blackSlope: 0.4,
      blackOffset: 0.008, // r12: 0.012 -> 0.008. r8: PBR Neutral black plateau for CHROMATIC pixels (neutral keeps Khronos 0.04; see pbrNeutral)
      // r7: neutral darks pulled toward `target` (display luma): shaded asphalt
      // 16 -> 19, sunlit 30 -> 26 (ref05 flat ~22). Coloured darks exempt.
      asphalt: { amount: 0.8, target: 0.08 },   // r8: 0.55/0.086 -> 0.8/0.08 (holds roads at ~28/255 under the lift)
      // r8: shaded-face floor (see composite). amount = luma lift at display
      // 0.33 (0 = off); neutral = share of the lift added as grey sky light.
      // r9: `shape` n of the lift kernel y (1-y)^n (2 = r8) and `green`, the
      // amount lawn hues keep. The r8 values stay at iso-mid and closer (critic
      // r8 praised iso-close); overview zooms blend to overview.floorShape /
      // floorNeutral / floor (see there).
      // r10 (critic r9: "too dark and dense at mid/far zoom; shadowed right
      // faces go greyish and desaturated"): lift 0.15 -> 0.24, grey share
      // 0.4 -> 0.15 (grey added to a shade face = the greyish cast; the lift now
      // keeps its hue, so a blue tower's right face reads light blue, not slate),
      // kernel n 2 -> 2.5 (peak at y 0.29, so the light paving/kerbs that made
      // r8 read pale move less than the shade faces).
      // r11: neutral 0.15 -> 0 (critic r10: shade faces and AO "mix toward grey"): the
      // whole lift now keeps the face's own hue.
      // r12 (critic r11: "raise the shadow and ambient floor so shaded faces stay
      // mid-tone; ref05 keeps its shade sides light and colourful"): 0.24 -> 0.36,
      // kernel 2.5 -> 2.1 (peak y 0.32: the deep shade band, awning undersides).
      // w2r1: 0.24 -> 0.18. White probe cube (tools/rendertest/faceratio.sh) right/top
      // was 0.69 at 0.24 vs the ref04 target 0.63; 0.17 measured 0.64. The shade side
      // is now ON target, which is what gives iso-mid its three-tone read back.
      floor: { amount: 0.18, neutral: 0.0, shape: 2.5, green: 0.15 },
      // r12 above-ground key (world Y lo..hi): pixels above the ground layer are
      // exempt from the asphalt ops and take the floor lift even when neutral.
      above: { enabled: true, amount: 1.0, lo: 1.0, hi: 1.3 },   // roads y 0, sidewalks ~0.3, lot tops ~0.9
      coolSat: 0.22,      // r12: 0.15 -> 0.22 (critic r11: "the mass of blue windows"). saturation cut on cyan..blue (critic: cyan-dominated)
      coolHue: 195,
      // wave-2 r1 (coherence #5: "dusk grades the whole city salmon/peach,
      // white and blue buildings included — the strongest tint in the game").
      // Twilight white balance: a partial von Kries adaptation in scene-linear
      // toward the DAYTIME illuminant. The illuminant is estimated from the
      // scene lights (engine hands them over via setLights): key colour x
      // intensity x sunWeight + hemi sky + ambient; its chroma is compared to
      // the day reference (captured live whenever nightEff < 0.05) and the
      // frame is multiplied by (ref / cur)^k, luma-normalised, each channel
      // clamped to [1/maxGain, maxGain]. k = amount x a twilight gate
      // (smoothstep lo0..lo1 in, hi0..hi1 out) so day and full night are
      // bit-identical. Deterministic (no frame statistics): no pumping when the
      // camera pans over the lake. Dusk keeps a golden key — only the wash goes.
      wb: { amount: 0.35, sunWeight: 0.35, lo0: 0.2, lo1: 0.36, hi0: 0.5, hi1: 0.66, maxGain: 2.0 },
    },
    // Anti-aliasing. `ssaa` is the MAX internal render scale (ordered-grid
    // supersampling, resolved with a separable Mitchell-Netravali filter);
    // the actual scale is limited so the internal target stays under
    // `ssaaPixels` — a retina canvas (already 2x) gets none, a 1x 1280x720
    // canvas gets the full scale. Combined with MSAA this gives ~9-16
    // coverage samples per output pixel on every voxel edge, so FXAA (which
    // smears texture detail) is dropped whenever ssaa is active.
    aa: {
      enabled: true, subpix: 0.75, edgeThreshold: 0.166, edgeThresholdMin: 0.0833,
      ssaa: 1.75, ssaaPixels: 2.3e6,
      // Mitchell-Netravali (B,C). B+2C = 1 keeps it on the "good" line; B 0.2
      // is crisper than the 1/3,1/3 default (critic: "reads soft") with only a
      // faint 1-2% negative lobe — no visible ringing on voxel edges.
      filterB: 0.2, filterC: 0.4,
      // r11 (critic r10: "fine detail is soft and lacks micro-contrast"): FXAA
      // is skipped when MSAA >= fxaaMsaa AND pixelRatio >= 1.5. At dpr 2 with
      // 4x MSAA every geometric edge already has 16 coverage samples per CSS
      // px; FXAA's sub-pixel pass (subpix 0.75) only smeared 1-device-px
      // detail — same frame, iso-mid, mean |Laplacian| at 1920 wide 0.137 ->
      // 0.159 without it, and no visible stair-steps. 1x canvases that cannot
      // supersample keep FXAA. 0 = always FXAA.
      fxaaMsaa: 4,
    },
    sharpen: { enabled: false, amount: 0.3, beforeAA: true },  // coordinator 16:50: off — ringing/crunchy edges (A/B scratchpad paint/cmp.png)
    // r11 — post-AA "crisp" pass: two-band luma unsharp mask in DISPLAY space
    // at the very end of the chain (after AA / the supersampling resolve), so
    // it sharpens the final pixels rather than steps FXAA later smooths.
    //   fine: y - G(sigmaFine)            acutance on every voxel edge, sign,
    //                                     AC unit and window frame
    //   mid : G(sigmaFine) - G(sigmaMid)  local contrast between a facade and
    //                                     its neighbours ("pop"; the critic's
    //                                     "steepen the local contrast curve")
    // Both blurs run at CSS resolution (a retina frame gets the same look after
    // any downscale) on a luma-only target, so the pass is 4 tiny blits.
    // Each band is CORED (|band| under coreLo is left alone: SSAO grain,
    // shading ripples, paving speckle stay as soft as they came) and SOFT-
    // LIMITED (x / (1 + |x| / limit)): a big step sharpens to a crisp ~1 CSS px
    // rim without the white/black ringing a hard USM draws. Applied as a luma
    // RATIO so hue is kept, with headroom so whites cannot clip and asphalt
    // cannot crush. `close` scales both bands once a building voxel is over
    // closeLo..closeHi CSS px (the coordinator's close-zoom ringing veto).
    // r12 (critic r11: "too much sharpening: dark outline halos and crunchy edge
    // sharpening wrap every small object"; the coordinator's close-zoom rule):
    // distance-gated to ZERO below camDist distLo (iso-close 36, iso-mid 85 gets
    // ~5%) and full only from distHi (overview), and gentler there: fine 0.9 ->
    // 0.5, the wide mid band (which drew the dark rims round bright props) 0.35
    // -> 0.1.
    // w2r1 (brief: "ref05's crisp, airy read at overview; zoom-gated local contrast
    // allowed; iso-close / one-* stay clean"): the gate moves to distLo 50 / distHi 85
    // so iso-mid (85, the shot that matches ref05's scale) gets the full pass and
    // iso-close (36) and single-building shots (22-45) still get exactly 0. Stronger
    // there (fine 0.5 -> 1.1, mid 0.1 -> 0.45, limits 0.08/0.05 -> 0.12/0.08) and cored
    // a little higher (0.006/0.03 -> 0.01/0.035) so asphalt grain is not lifted.
    // Measured iso-mid downscaled to ref05 px/tile: |Laplacian| 0.126 -> 0.169 (ref05
    // 0.188), 16-px local contrast 0.140 -> 0.164 (ref 0.182); no rims on the A/B.
    crisp: { enabled: true, fine: 1.1, mid: 0.45, sigmaFine: 1.0, sigmaMid: 4.0,
      coreLo: 0.01, coreHi: 0.035, limitFine: 0.12, limitMid: 0.08, close: 0.55, closeLo: 5, closeHi: 12,
      distLo: 50, distHi: 85,
      // w4r1 — HALO CLAMP on the fine band: the sharpened luma may not leave the
      // pixel's own neighbourhood range (8 taps `step` CSS px away) by more than
      // `overshoot` x that range. An edge still steepens to ~1 CSS px (the
      // acutance), but the bright/dark rim the USM draws BESIDE it (white lines
      // on parapets, dark lines round props at overview) is gone. The mid band
      // (local contrast) keeps its own soft limit. overshoot < 0 = off.
      clampStep: 1.0, overshoot: 0.12 },
    // Round 4: output-resolution luma unsharp mask (see OUTPUT_FRAG), halo-
    // clamped to each pixel's 3x3 range so flat faces and lawns are untouched.
    usm: { enabled: false, fine: 0.6, edge: 0.5, radius: 2.5, overshoot: 0.15, coreLo: 0.05, coreHi: 0.14, noSS: 0.4, farLo: 2.0, farHi: 4.5 },
    // Round 6 — small-feature chroma restraint (see OUTPUT_FRAG). Critic r5:
    // at overview zoom every window, prop and rooftop unit is at full chroma,
    // so the dense blocks turn into colour speckle; ref05 (a 4:2:0 JPEG with
    // a calmer grade) reads each block as one mass with a few accents.
    // Measured high-frequency chroma (|chroma - 7px box|, 1920 wide): ref05
    // 0.063, ours 0.122 — while MEAN saturation already matched (0.351 vs
    // 0.366). So this is not a global saturation cut: a pixel whose colour is
    // shared by fewer than ~a third of its neighbours on two rings (radius
    // `radius` CSS px and half that) is a small feature and loses up to
    // `chroma` of its saturation, luma untouched. Big faces (interior
    // similarity ~1) and straight edges between big faces (~0.55) keep full
    // colour, and because the ring is in screen pixels, close zooms (where a
    // window is 20+ px) are untouched — the effect scales in with distance.
    // `luma` pulls those same small features' luminance a little toward their
    // surroundings (anti-speckle at far zoom; 0 = off).
    // Revised after the coordinator's 16:50 A/B: luma pull was OFF (it
    // raggedised edges at close zoom; r7 brings back 0.35, far zoom only, to
    // calm tower window grids at overview — critic r6 moire), a ring-uniformity gate so AA edge pixels are never
    // touched, and a zoom gate (zoomLo..zoomHi device px per building voxel)
    // so nothing changes at iso-mid or closer.
    // r11 (critic r10: "roof clutter, signs and shopfronts blur into a busy mid-tone
    // speckle"): the luma pull flattened exactly that detail toward mid-tone, and
    // the chroma cut greyed it. luma 0.35 -> 0, chroma 0.55 -> 0.35.
    detail: { enabled: true, chroma: 0.35, luma: 0.0, radius: 3.0, simLo: 0.07, simHi: 0.2, lo: 0.2, hi: 0.55, zoomLo: 4, zoomHi: 8 },
    // Silhouette ink: darkens the near side of real depth steps (see the
    // composite). minStep in world units; minPixels keeps a far zoom from
    // inking every facade voxel.
    // Round 7: width (CSS px) + slope (threshold in ring radii of world size).
    // Critic r6: "silhouettes lack the crisp dark edges of ref05; objects run
    // into the asphalt and into each other". 0.75 at 1.5 CSS px reads as a thin
    // coloured-dark rim at the critic's downscale without looking drawn-on.
    // r10: 0.75 -> 0.5 (critic r9: "dark edge/outline-like darkening along facades
    // and roof rims"; r6 won with no ink at all).
    // coordinator 22:15: OFF. r6 (the only post win) had no ink; surface r6/r12, light r8 and
    // post r9/r11 critics all lost rounds to dark silhouette halos from this pass.
    edge: { enabled: false, strength: 0.5, minStep: 0.3, minPixels: 2, width: 1.5, slope: 4 },
    // night w4r4: moonlit silhouette rim — a thin pale-blue line on the near
    // side of every depth step at night (roof edges, towers against the next
    // tower), so unlit masses separate. Scaled by the night factor (0 by day).
    // strength = mix toward `color` (display sRGB) at the rim's core.
    moonRim: { enabled: true, strength: 0.55, width: 1.4, minStep: 0.35, slope: 3, color: [0.55, 0.66, 0.82] },
    // Round 9 — overview read (critic r8, 'iso' shot: "soft, slightly hazy,
    // pale is the dominant cast; buildings and lots don't stand out; ref05 has
    // crisp dark silhouette edges and much stronger local contrast"). A zoom
    // factor ov = 1 while a building voxel is under `lo` CSS px, 0 from `hi`
    // up, so iso-mid and closer are unchanged. At ov = 1 the ink uses
    // inkStrength/inkSlope and the shade floor is scaled by `floor`.
    // floor/floorShape/floorNeutral: at ov = 1 the shade floor lifts half as
    // much (deeper shade sides: "the towers' right faces read only slightly
    // darker"), with kernel n = 3 (lift stays on the shaded band and comes off
    // the light upper mids — ground, paving and kerbs had been raised ~7%) and
    // less of it as grey (grey added to darks = haze). Lawn hues are spared.
    // Round 10 — critic r9 picked the reference over exactly this: "at overview
    // the grade is too dark and dense: near-black gaps, a dark outline along
    // facades and roof rims, busy high-frequency mush, greyish shade faces".
    // Same-frame A/B (iso): the r9 overview ops alone took p50 138 -> 117 and
    // ink 1.0 another -11. So: the floor is no longer halved (0.85 of the
    // global lift, same kernel), the ground key is OFF, ink 1.0 -> 0.25 and
    // the overview USM fine band 0.35 -> 0.2 (anti-mush). iso p50 111 -> ~148.
    overview: { enabled: true, lo: 2.4, hi: 3.4, floor: 0.85, floorShape: 2.5, floorNeutral: 0.0,
      inkStrength: 0.0, inkSlope: 2.5,   // r12: 0.25 -> 0 (ink off at every zoom)
      ground: { amount: 0.0, y0: 1.15, y1: 1.7, lo: 0.45, hi: 0.85, satLo: 0.3, satHi: 0.55 },
      // r12: off — the distance-gated crisp pass is the one overview sharpener.
      sharpen: { enabled: false, fine: 0.2, edge: 0.5, radius: 1.25, overshoot: 0.1, coreLo: 0.04, coreHi: 0.12 } },
    // w4r2 — CITY-SCALE depth (critic w4r1: "flat and pastel, as if a milky
    // layer sits over the frame; in the downtown cluster the shaded right
    // faces, tower stripes, window recesses and the gaps between buildings all
    // sit in one narrow mid-value band"). Same camDist gate as crisp: exactly 0
    // below distLo (iso-close 36, one-* 22-45, and the faceratio.sh probe, so
    // the close-zoom look and the measured 1 : 0.89 : 0.63 face ratio are
    // untouched), full from distHi (iso-mid 85 and farther). At k = 1:
    //   floor      x0.5 on the shade-floor lift (grade.floor.amount 0.18 ->
    //              0.09). The lift's kernel peaks at display luma ~0.29, i.e.
    //              crevices, recesses and dark-coloured shade faces, not a
    //              white wall's shade side (~0.6), so this deepens the accents
    //              without greying the right faces.
    //   voxelKeep  voxel faces take this share of the contact + cavity SSAO
    //              (0 closer in: surface r7's bakery halos). At iso-mid a voxel
    //              is ~7 device px, so the AO sits IN ledges, under signs and at
    //              tower feet rather than rimming them.
    //   voxelCanyon / canyonIntensity: the broad skylight term. It was
    //              0.18 x 0.1 = 1.8% on voxel faces (effectively off); here it
    //              darkens the canyons between towers and each tower's foot.
    // Measured same frame iso-mid (1920-wide equivalent): p25/p50 104/144 ->
    // ~80/125 (ref05 68/140; ours has far less visible asphalt), share < 0.35
    // .19 -> ~.30 (ref05 .33), 16-px local contrast .161 -> ~.185 (ref .182).
    depth: { enabled: true, distLo: 50, distHi: 85, floor: 0.5, voxelKeep: 0.5, voxelCanyon: 1.0, canyonIntensity: 0.35 },
    // Debug / harness
    split: 0.0,           // 0 = full post, >0 = raw scene left of this uv.x
    debug: 'none',        // none | ao | bloom | coc | depth | normals | raw
  };
}

// Per-quality derived knobs. `aoSamples` now costs TWO depth taps each (contact
// + cavity), so the counts are lower than the single-radius version for the same
// bandwidth.
const QUALITY_TABLE = [
  // 0: low — no SSAO, no DOF, FXAA only, half-res bloom, no MSAA
  { msaa: 0, ao: false, aoScale: 0.5, aoSamples: 8,  dof: false, dofScale: 0.5, dofTaps: 12, bloomMips: 4, bloomScale: 0.5, aa: true, sharpen: false, ss: false },
  // 1: medium — half-res SSAO, 4x MSAA + FXAA
  { msaa: 4, ao: true,  aoScale: 0.5, aoSamples: 10, dof: true,  dofScale: 0.5, dofTaps: 24, bloomMips: 5, bloomScale: 0.5,  aa: true, sharpen: true, ss: false },
  // 2: high — supersampled (see aa.ssaa) + 4x MSAA, SSAO at the internal res
  //    (x0.75 when supersampling, i.e. still >= output res), FXAA only when
  //    the canvas is already too big to supersample.
  { msaa: 4, ao: true,  aoScale: 1.0, aoSamples: 12, dof: true,  dofScale: 0.5, dofTaps: 40, bloomMips: 6, bloomScale: 0.5,  aa: true, sharpen: true, ss: true },
];

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const COMMON = /* glsl */`
#define TAU 6.28318530718

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 1.0 when the scene camera is an OrthographicCamera (engine.js's true-iso
// game camera). Orthographic depth is already LINEAR in view Z.
uniform float uOrthoCam;

// Depth buffer value -> view-space distance. Perspective: positive distance.
// Orthographic: n + d*(f-n) — may be negative, since the iso camera uses a
// negative near plane so tall towers never clip.
float linearDepth(float d, float n, float f) {
  if (uOrthoCam > 0.5) return n + d * (f - n);
  float z = d * 2.0 - 1.0;
  return (2.0 * n * f) / (f + n - z * (f - n));
}

vec3 srgbEncode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;

const VIEWPOS = /* glsl */`
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uNear;
uniform float uFar;

// uv in 0..1, dist a positive view distance -> view-space position (z negative).
// Ortho: uTanHalfFov carries the view HALF-HEIGHT in world units (engine
// sets it; see PostFX.render) and rays are parallel.
vec3 viewPosFromUv(vec2 uv, float dist) {
  vec2 ndc = uv * 2.0 - 1.0;
  if (uOrthoCam > 0.5) return vec3(ndc.x * uTanHalfFov * uAspect, ndc.y * uTanHalfFov, -dist);
  return vec3(ndc.x * uTanHalfFov * uAspect, ndc.y * uTanHalfFov, -1.0) * dist;
}
vec2 uvFromViewPos(vec3 p) {
  if (uOrthoCam > 0.5) return vec2(p.x / (uTanHalfFov * uAspect), p.y / uTanHalfFov) * 0.5 + 0.5;
  vec2 ndc = vec2(p.x / (uTanHalfFov * uAspect), p.y / uTanHalfFov) / max(1e-5, -p.z);
  return ndc * 0.5 + 0.5;
}
`;

// ---------------------------------------------------------------------------
// Pass shaders
// ---------------------------------------------------------------------------

const SSAO_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform vec2  uTexel;        // 1 / full-res size (depth texture texel)
uniform vec2  uAOSize;       // AO buffer size, pixels (gl_FragCoord space)
uniform vec3  uKernel[16];
uniform int   uSamples;
uniform float uRadius;            // wide cavity radius, world units
uniform float uContactRadius;     // tight contact radius, world units
uniform float uCanyonRadius;      // broad canyon term radius, world units
uniform float uCanyonIntensity;   // 0 = off
uniform float uBias;
uniform float uIntensity;
uniform float uContactIntensity;
uniform float uPower;
uniform float uContactPower;
uniform float uMinPixels;
uniform float uMaxPixels;
uniform float uPlaneBias;    // tangent-plane gate width, as a fraction of the radius
// Occluder gate (surface r5): scene alpha is "how much SSAO this pixel takes"
// (materials.js ssaoKeep; voxel = 0). With uCastGate 1 it also scales how much
// the pixel CASTS: voxel models carry their own baked AO (voxel.js ray AO,
// ground plane included), so the ground beside a voxel lot plinth no longer
// gets a second, ragged 1-2 px contact seam from the screen-space pass.
uniform sampler2D tScene;
uniform float uCastGate;
${COMMON}
${VIEWPOS}

float rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }

vec3 posAt(vec2 uv) {
  float d = rawDepth(uv);
  return viewPosFromUv(uv, linearDepth(d, uNear, uFar));
}

// One hemisphere sample -> range-checked occlusion in 0..1.
//
// TWO gates, and the second one is the whole reason distant ground stopped
// going black:
//
//  (a) the surface at the sample's screen position must be in FRONT of the
//      sample point (the classic hemisphere test), and
//  (b) that surface must RISE above the centre fragment's own tangent plane.
//
// (b) is not something a depth bias can express. When the ground is seen at a
// grazing angle, a tangential hemisphere sample travels almost straight down
// the view ray: it moves several world units DEEPER while moving a fraction of
// a pixel across the screen. Gate (a) then compares that sample against the
// depth of the SAME piece of ground it came from, finds it "behind" by several
// units, and reports occlusion — with the range check wide open, because the
// two depths it compares (z0 and the sampled surface) are the same number.
// Measured at the region shot: the contact term alone drove distant grass to 0.38
// (62% occluded) with nothing within eight tiles of it, while the wide cavity
// term — whose samples do project several pixels away — stayed flat at 0.90.
//
// Gate (b) is exact for a plane rather than merely tolerant of one: the sample
// uv is SNAPPED to the centre of the depth texel that is about to be read, so
// the tangent-plane depth is evaluated at precisely the point the sampled depth
// belongs to. For coplanar ground 'rise' is then zero by construction — no
// tolerance has to absorb the depth gradient, which at a grazing angle is
// ~2 world units per pixel and would swamp any fixed bias.
//
// 'tol' is the residual budget (depth quantisation + normal-reconstruction
// error), 'soft' the ramp width, both computed once per fragment in main().
float occlude(vec3 sp, vec3 P, vec3 N, float z0, float rad, float tol, float soft) {
  if (sp.z > -uNear) return 0.0;
  vec2 suv = uvFromViewPos(sp);
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) return 0.0;
  suv = (floor(suv / uTexel) + 0.5) * uTexel;     // snap to the depth texel centre
  float sd = rawDepth(suv);
  if (sd >= 0.999995) return 0.0;                 // sky occludes nothing
  float sz = linearDepth(sd, uNear, uFar);
  if (sz >= -sp.z - uBias) return 0.0;

  float w = 1.0;
  if (uPlaneBias >= 0.0) {
    // Height of the occluder above the tangent plane at P, in world units.
    // Positive == a real ledge/wall/kerb; ~0 == the same surface, sampled
    // edge-on; negative == below the horizon, which occludes nothing.
    float rise = dot(viewPosFromUv(suv, sz) - P, N);
    if (rise <= tol) return 0.0;
    w = smoothstep(tol, tol + soft, rise);
  }

  // Occluder gate (see uCastGate) last, so only real occluders pay the fetch.
  float castK = mix(1.0, clamp(texture2D(tScene, suv).a, 0.0, 1.0), uCastGate);
  // Range check: geometry far in FRONT of this sample must not cast occlusion
  // onto it, or every silhouette grows a halo.
  return castK * w * smoothstep(0.0, 1.0, rad / max(1e-4, abs(z0 - sz)));
}

// 4x4 ordered (Bayer) tile: 16 distinct values, each appearing exactly once per
// tile. Used as the kernel rotation phase. The AO denoise below averages
// exactly one full tile period in each axis, so the phase term cancels
// identically instead of merely being attenuated -- which is what turns a
// 1-pixel rotation into a permanent checkerboard once CAS amplifies it.
float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(a * 0.5) * 0.25 + bayer2(a); }

void main() {
  // Snap the centre to the depth texel it reads. When the AO buffer is not an
  // integer fraction of the depth buffer (supersampling: AO at 0.75x of a
  // 1.625x internal target) the AO pixel centre lands at a different sub-texel
  // phase in every column; reconstructing P at the unsnapped uv puts it off
  // the surface by (depth gradient x phase), the tangent-plane gate reads that
  // as a rise, and the result is column-periodic false occlusion — visible as
  // vertical "brushed metal" streaks on every wall.
  vec2 cuv = (floor(vUv / uTexel) + 0.5) * uTexel;
  float d0 = rawDepth(cuv);
  // Sky: never occlude. g == 0 is also the sky marker for the harness.
  if (d0 >= 0.999995) { gl_FragColor = vec4(1.0, 1.0, 0.5, 0.5); return; }

  float z0 = linearDepth(d0, uNear, uFar);
  vec3 P = viewPosFromUv(cuv, z0);

  // Edge-aware normal reconstruction (pick the closer of the two neighbours per axis).
  vec3 pR = posAt(cuv + vec2(uTexel.x, 0.0));
  vec3 pL = posAt(cuv - vec2(uTexel.x, 0.0));
  vec3 pU = posAt(cuv + vec2(0.0, uTexel.y));
  vec3 pD = posAt(cuv - vec2(0.0, uTexel.y));
  vec3 dx = (abs(pR.z - P.z) < abs(P.z - pL.z)) ? (pR - P) : (P - pL);
  vec3 dy = (abs(pU.z - P.z) < abs(P.z - pD.z)) ? (pU - P) : (P - pD);
  vec3 N = normalize(cross(dx, dy));
  // Face the camera (ortho: the view ray is the constant -Z axis).
  if (dot(N, (uOrthoCam > 0.5) ? vec3(0.0, 0.0, -1.0) : P) > 0.0) N = -N;

  float a = bayer4(gl_FragCoord.xy) * TAU;
  vec3 rv = vec3(cos(a), sin(a), 0.0);
  vec3 T = normalize(rv - N * dot(rv, N));
  vec3 B = cross(N, T);
  mat3 TBN = mat3(T, B, N);

  // Screen-space clamp on both radii. The floor keeps the contact term at least
  // a couple of pixels wide at distance (otherwise every sample lands in the
  // centre texel and contact vanishes at the far end of the street); the
  // ceiling stops the cavity term from turning into a full-screen gather when
  // the camera is right down at the kerb.
  float pxPerWorld = (0.5 * uAOSize.y) / max(1e-4, uTanHalfFov * ((uOrthoCam > 0.5) ? 1.0 : z0));
  float rWide    = clamp(uRadius        * pxPerWorld, uMinPixels, uMaxPixels)        / pxPerWorld;
  float rTight   = clamp(uContactRadius * pxPerWorld, uMinPixels, uMaxPixels * 0.35) / pxPerWorld;

  // Residual budget for the tangent-plane gate: 24-bit depth quantisation
  // (which grows as z^2) plus the ~2 deg error in the reconstructed normal,
  // whose contribution over a tangential step of 'rad' is ~0.035 * rad. Both
  // are tiny next to the grazing depth gradient the snap already removed.
  float quant = (uOrthoCam > 0.5) ? (uFar - uNear) * 1.2e-7
                                  : z0 * z0 * (uFar - uNear) / max(1e-4, uNear * uFar) * 1.2e-7;
  float tolW = uBias + quant + 0.035 * rWide;
  float tolT = uBias + quant + 0.035 * rTight;
  float softW = max(1e-4, uPlaneBias * rWide);
  float softT = max(1e-4, uPlaneBias * rTight);

  // Canyon term (round 3): a broad, gentle skylight term for GROUND pixels
  // (roads, grass, pavements) boxed in by tall walls — the street canyons
  // between towers that ref05 shades and we left flat. Since round 5 voxel
  // faces take it too (ssao.voxelKeep): it is the soft darkening toward the
  // foot of a wall and the deck of a roof inside its parapet. A small prop
  // subtends little of a large hemisphere, so no skirts on grass.
  float rCanyon = clamp(uCanyonRadius * pxPerWorld, uMinPixels, uMaxPixels * 1.5) / pxPerWorld;
  float tolC = uBias + quant + 0.035 * rCanyon;
  float softC = max(1e-4, max(uPlaneBias, 0.12) * rCanyon);
  bool canyon = uCanyonIntensity > 0.0;

  float occW = 0.0;
  float occT = 0.0;
  float occC = 0.0;
  float total = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uSamples) break;
    vec3 k = TBN * uKernel[i];
    occW += occlude(P + k * rWide,  P, N, z0, rWide,  tolW, softW);
    occT += occlude(P + k * rTight, P, N, z0, rTight, tolT, softT);
    if (canyon) occC += occlude(P + k * rCanyon, P, N, z0, rCanyon, tolC, softC);
    total += 1.0;
  }
  float inv = 1.0 / max(1.0, total);

  // Two terms, MULTIPLIED. The wide one is the cavity/skylight term (street
  // canyons, courtyards, the underside of an arch). The tight one is contact
  // occlusion -- the dark seam at a kerb step, a wheel on asphalt, a wall
  // meeting the pavement. A single radius cannot be both: at 5 world units the
  // kernel steps straight over a 1-unit kerb and paints a broad fake vignette
  // up tall walls instead.
  float aoW = pow(clamp(1.0 - occW * inv * uIntensity,        0.0, 1.0), uPower);
  float aoT = pow(clamp(1.0 - occT * inv * uContactIntensity, 0.0, 1.0), uContactPower);

  // Channel layout: r = AO, g = view depth NORMALISED by far (a >0 sky marker
  // only — the denoise reads the real depth texture, because 8 bits over
  // 0..2000 world units cannot resolve a 1-unit kerb), ba = view normal xy.
  // The normal is what lets the bilateral reject a wall texel that sits at the
  // SAME depth as the ground texel it meets, which is exactly the contact seam
  // the filter was smearing away.
  float aoC = canyon ? clamp(1.0 - occC * inv * uCanyonIntensity, 0.0, 1.0) : 1.0;

  // Round 6: g now carries the CANYON term alone (the old z/far sky marker
  // was never read — the denoise uses the real depth texture). The LIT pass
  // gives voxel pixels, which opt out of the full AO, this broad skylight term
  // only (ssao.voxelCanyon): soft mid-tone mass shading, no contact halos.
  gl_FragColor = vec4(aoW * aoT * aoC, aoC, N.x * 0.5 + 0.5, N.y * 0.5 + 0.5);
}`;

// Separable bilateral (depth + normal aware) AO denoise.
//
// Weights [1,2,2,2,1]/8 over offsets -2..+2 == the mean of the two 4-wide boxes
// that straddle the centre texel. Four CONSECUTIVE texels contain each of the
// four column phases of the 4x4 rotation tile exactly once, so the horizontal
// pass produces a value that depends only on the row phase; the vertical pass
// then averages the four row phases and the result is independent of both.
// The rotation therefore cancels exactly rather than being attenuated at a
// different frequency than it was introduced (the old kernel sampled at a
// stride of 2 at full res, so odd and even columns never mixed at all and the
// per-pixel checkerboard survived untouched into CAS).
//
// Two things make it an actual BILATERAL and not a Gaussian wearing the name:
//
//  1. It reads the real depth texture. The previous version compared the AO
//     buffer's own .g channel, which held a raw 0..far view distance written to
//     an 8-bit RGBA target: every non-sky texel quantised to 1.0, every weight
//     collapsed to exp(0) == 1, and the filter averaged the unoccluded ground
//     BEYOND a wall straight into the contact texel at its base. That is why
//     the profile could come out non-monotonic — lighter at 1 px from the wall
//     than at 2 px, i.e. exactly backwards.
//
//  2. It predicts each tap's depth from the local PLANE (an edge-aware
//     one-sided slope along the blur axis) instead of comparing raw depths.
//     A ground plane running away from a low camera changes depth by several
//     units across five texels; a flat depth tolerance either rejects the whole
//     ground (leaving the kernel rotation uncancelled) or is so loose it also
//     accepts the silhouette. Predicting removes the slope and leaves only the
//     discontinuity, so the tolerance can be tight.
//
// The normal term handles the case depth cannot: a wall meeting the pavement is
// CONTINUOUS in depth but flips 90 degrees in normal.
//
// uDir must be exactly ONE AO texel along the blur axis.
const AO_BLUR_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform vec2 uDir;
uniform float uNear;
uniform float uFar;
uniform float uDepthSigma;     // tolerance as a fraction of view depth
uniform float uNormalPower;
${COMMON}

float rawD(vec2 uv) { return texture2D(tDepth, uv).x; }
float linZ(vec2 uv) { return linearDepth(rawD(uv), uNear, uFar); }
vec3 unpackN(vec4 s) {
  vec2 xy = s.zw * 2.0 - 1.0;
  return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}

void main() {
  vec4 c = texture2D(tAO, vUv);
  if (rawD(vUv) >= 0.999995) { gl_FragColor = c; return; }   // sky: pass through

  float zc = linZ(vUv);
  vec3  n0 = unpackN(c);
  float tol = max(1e-4, uDepthSigma * zc);

  // Edge-aware one-sided slope, per texel, along the blur axis: take the
  // SMALLER of the two neighbour differences so a silhouette on one side does
  // not corrupt the plane prediction used on the other.
  float sp = linZ(vUv + uDir) - zc;
  float sm = zc - linZ(vUv - uDir);
  float slope = (abs(sp) < abs(sm)) ? sp : sm;

  vec2 sum = c.rg * 2.0;
  float wsum = 2.0;
  for (int i = 0; i < 4; i++) {
    float k = (i == 0) ? -2.0 : ((i == 1) ? -1.0 : ((i == 2) ? 1.0 : 2.0));
    float w = (abs(k) > 1.5) ? 1.0 : 2.0;
    vec2 uv = vUv + uDir * k;
    vec4 s = texture2D(tAO, uv);
    float sky = step(0.999995, rawD(uv));
    float wz = exp(-abs(linZ(uv) - (zc + slope * k)) / tol);
    float wn = pow(max(0.0, dot(unpackN(s), n0)), uNormalPower);
    float ww = w * wz * wn * (1.0 - sky);
    sum += s.rg * ww;
    wsum += ww;
  }
  gl_FragColor = vec4(sum / max(1e-4, wsum), c.b, c.a);
}`;

const LIT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tAO;
uniform float uAO;        // 0 = off
uniform vec3  uAOTint;
uniform float uAOChroma;  // saturation gain at full occlusion
uniform float uVoxelKeep; // floor on the scene-alpha AO gate (0 = honour ssaoKeep)
uniform float uVoxelCanyon; // canyon-only AO on the part a pixel's gate opted OUT of
${COMMON}
void main() {
  vec4 c = texture2D(tScene, vUv);
  if (uAO > 0.0) {
    vec2 aoS = texture2D(tAO, vUv).rg;
    float ao = aoS.r;
    // Scene alpha = how much SSAO this pixel takes. Every opaque pass writes
    // 1.0; voxel buildings/props write materials.js's ssaoKeep because they
    // carry exact per-vertex AO already (surface r2).
    float keep = clamp(c.a, 0.0, 1.0);
    keep += (1.0 - keep) * uVoxelKeep;
    // Scene alpha < -0.5 (props.js rocks, veg r11): an explicit keep of
    // -alpha - 1 that bypasses the voxelKeep floor — the rock carries its own
    // crisp baked pocket AO, and the contact term smeared every step of it
    // into soft "bevelled" gradients. (A byte target clamps it to 0 -> floor.)
    float canK = (1.0 - keep) * uVoxelCanyon;
    if (c.a < -0.5) { keep = clamp(-c.a - 1.0, 0.0, 1.0); canK = 0.0; }
    ao = mix(1.0, ao, uAO * keep);
    // Round 6 (critic r5: ref05 "soft mid-tone ambient occlusion makes each
    // block read as one clean mass"). Voxel faces skip the contact/cavity
    // terms (surface r7: halos), but take the broad canyon term: a soft
    // darkening toward a tower's foot, inside a parapet, down a street canyon.
    ao *= mix(1.0, aoS.g, uAO * canK);
    c.rgb *= ao * mix(uAOTint, vec3(1.0), ao);
    // Occluded light is bounced light: it has picked up the colour of the
    // surfaces around it, so a corner goes DEEPER in hue rather than greyer
    // (ref04's orange corners). Luminance-preserving, ratio-safe gain.
    if (uAOChroma > 0.0) {
      float y = luma(c.rgb);
      vec3 dev = c.rgb - vec3(y);
      float mn = min(min(dev.r, dev.g), dev.b);
      float k = 1.0 + uAOChroma * (1.0 - ao);
      if (mn < -1e-6) k = min(k, 0.8 * y / -mn);
      c.rgb = max(vec3(0.0), vec3(y) + dev * max(1.0, k));
    }
  }
  gl_FragColor = c;
}`;

const BLOOM_THRESH_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uSoftness;
uniform float uClamp;
${COMMON}
vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  // 4-tap box prefilter with Karis average -> kills single-pixel fireflies.
  vec3 s0 = tap(vec2(-1.0, -1.0));
  vec3 s1 = tap(vec2( 1.0, -1.0));
  vec3 s2 = tap(vec2(-1.0,  1.0));
  vec3 s3 = tap(vec2( 1.0,  1.0));
  float w0 = 1.0 / (1.0 + luma(s0));
  float w1 = 1.0 / (1.0 + luma(s1));
  float w2 = 1.0 / (1.0 + luma(s2));
  float w3 = 1.0 / (1.0 + luma(s3));
  vec3 c = (s0 * w0 + s1 * w1 + s2 * w2 + s3 * w3) / max(1e-4, w0 + w1 + w2 + w3);

  // Highlight roll-off. Limiting the magnitude by a PURE SCALE (not a per-
  // channel clamp) keeps the ratio between channels, so a saturated neon core
  // still blooms in its own hue instead of driving whichever channel is
  // largest into the ceiling and turning the core flat white. Without this a
  // far tower cluster stacks enough energy to smear yellow across a whole
  // block; with it the cluster spreads instead of piling up.
  float mag = max(max(c.r, c.g), c.b);
  c *= min(1.0, uClamp / max(1e-4, mag));

  float l = luma(c);
  float knee = max(1e-4, uThreshold * uSoftness);
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, l - uThreshold) / max(1e-4, l);
  gl_FragColor = vec4(c * contrib, 1.0);
}`;

// Call-of-Duty style 13-tap downsample: stable, no pulsing under motion.
const BLOOM_DOWN_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;      // texel size of the SOURCE mip
vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  vec3 a = tap(vec2(-2.0,  2.0)); vec3 b = tap(vec2( 0.0,  2.0)); vec3 c = tap(vec2( 2.0,  2.0));
  vec3 d = tap(vec2(-2.0,  0.0)); vec3 e = tap(vec2( 0.0,  0.0)); vec3 f = tap(vec2( 2.0,  0.0));
  vec3 g = tap(vec2(-2.0, -2.0)); vec3 h = tap(vec2( 0.0, -2.0)); vec3 i = tap(vec2( 2.0, -2.0));
  vec3 j = tap(vec2(-1.0,  1.0)); vec3 k = tap(vec2( 1.0,  1.0));
  vec3 l = tap(vec2(-1.0, -1.0)); vec3 m = tap(vec2( 1.0, -1.0));
  vec3 o = e * 0.125;
  o += (a + c + g + i) * 0.03125;
  o += (b + d + f + h) * 0.0625;
  o += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(o, 1.0);
}`;

// 9-tap tent upsample, drawn with additive blending into the finer mip.
const BLOOM_UP_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;      // texel size of the SOURCE (coarser) mip
uniform float uRadius;
vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }
void main() {
  vec3 o = tap(vec2(0.0, 0.0)) * 4.0;
  o += (tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0)) + tap(vec2(0.0, -1.0)) + tap(vec2(0.0, 1.0))) * 2.0;
  o += tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  gl_FragColor = vec4(o / 16.0, 1.0);
}`;

// Half-res colour + circle-of-confusion prepass for the bokeh gather.
const DOF_DOWN_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform vec2 uTexel;        // full-res texel
uniform float uFocus;
uniform float uRange;
uniform float uNearRange;
uniform float uStrength;
uniform float uTilt;
uniform float uTiltStart;
uniform float uTiltEnd;
uniform float uTiltCenter;
uniform float uSkyGuard;   // 1 = exclude the far plane from the CoC (see below)
${COMMON}
uniform float uNear;
uniform float uFar;

float cocAt(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  // The sky is at infinity and the depth buffer still holds the clear value
  // there (the sky dome writes no depth). Blurring it is the single most
  // obviously-wrong thing a tilt-shift can do: real miniature photography has a
  // pin-sharp backdrop because there is nothing at a finite distance to defocus.
  if (d >= 0.999995 && uSkyGuard > 0.5) return 0.0;

  float z = linearDepth(d, uNear, uFar);
  float dz = z - uFocus;
  // Asymmetric: the NEAR field defocuses over a shorter depth range than the
  // far field. That asymmetry is what reads as "macro lens on a model" rather
  // than "distant haze".
  float rng = (dz < 0.0) ? max(1e-3, uNearRange) : max(1e-3, uRange);
  float c = pow(clamp(abs(dz) / rng, 0.0, 1.0), 1.9) * uStrength;

  // Tilt-shift band, SYMMETRIC about the focal line at uTiltCenter. A one-sided
  // band (only above the line) leaves the near foreground sharp, and the near
  // blur is most of what sells the miniature look.
  //
  // The ramp SATURATES at uTiltEnd rather than at the frame edge. Ramping to
  // 1.0 puts smoothstep at ~0.11 halfway out, so the CoC over the middle 60% of
  // the picture was 0.01-0.03 — under the composite's own mix threshold, i.e.
  // the gather ran and its result was then multiplied by zero.
  float halfBand = (uv.y < uTiltCenter) ? uTiltCenter : (1.0 - uTiltCenter);
  float t = clamp(abs(uv.y - uTiltCenter) / max(0.05, halfBand), 0.0, 1.0);
  float tiltC = smoothstep(uTiltStart, max(uTiltStart + 0.05, uTiltEnd), t) * uTilt;
  return clamp(max(c, tiltC), 0.0, 1.0);
}

void main() {
  vec2 o = uTexel;
  vec3 c = texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2( o.x, -o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x,  o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2( o.x,  o.y)).rgb;
  c *= 0.25;
  float coc = max(max(cocAt(vUv + vec2(-o.x, -o.y)), cocAt(vUv + vec2(o.x, -o.y))),
                  max(cocAt(vUv + vec2(-o.x,  o.y)), cocAt(vUv + vec2(o.x,  o.y))));
  // The max() above dilates CoC by one texel so a blurred silhouette does not
  // get a hard sharp seam -- but it must never leak onto the sky, so veto on
  // the centre sample's own depth.
  coc *= 1.0 - uSkyGuard * step(0.999995, texture2D(tDepth, vUv).x);
  gl_FragColor = vec4(c, coc);
}`;

// Golden-angle spiral bokeh gather. A tap only contributes if its own CoC is at
// least as large as its distance from the centre — that's what stops sharp
// foreground from bleeding into blurred background (and vice versa).
//
// That test has to be done in PIXELS. The old form compared the tap's CoC
// against the NORMALISED spiral radius r (0..1), but r is normalised to the
// centre pixel's own disc, whose physical size is uRadiusPx * centreCoC. At a
// CoC of 0.3 the outermost tap sits 0.3 * uRadiusPx from the centre while the
// test still demanded a CoC of ~0.7 to accept it, so most of the disc was
// discarded and the effective radius collapsed to a fraction of the nominal
// one. Comparing tap-CoC-in-pixels against tap-distance-in-pixels is both the
// correct scatter-as-gather criterion and scale invariant.
const DOF_BOKEH_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDof;
uniform vec2 uTexel;       // half-res texel
uniform float uRadiusPx;
uniform int uTaps;
${COMMON}
void main() {
  vec4 c0 = texture2D(tDof, vUv);
  // Jitter only within one spiral sector: enough to break up banding, not
  // enough to turn the far field into sparkle noise.
  float jitter = hash12(gl_FragCoord.xy) * (TAU / float(uTaps));
  vec3 sum = c0.rgb;
  float wsum = 1.0;
  float maxCoc = c0.a;
  // Small CoC -> tight gather (cheap + crisp). The floor is only there so a
  // sharp pixel adjacent to a blurred one can still see it and not leave a
  // hard seam; it must stay small or the focal band picks up neighbours.
  float rad = uRadiusPx * max(c0.a, 0.12);
  // NOTE the bound is 48, not 32: with a hard cap of 32 the loop stopped at tap
  // 31 while t was still normalised by uTaps-1 == 39, so the outer 20% of the
  // disc was never sampled at all. That missing rim is exactly what read as
  // blocky structure in the far bokeh.
  for (int i = 1; i < 48; i++) {
    if (i >= uTaps) break;
    float t = float(i) / float(uTaps - 1);
    float r = sqrt(t);
    float ang = float(i) * 2.39996323 + jitter;
    float distPx = r * rad;
    vec2 off = vec2(cos(ang), sin(ang)) * distPx;
    vec4 s = texture2D(tDof, vUv + off * uTexel);
    // Does this tap's own blur circle, in PIXELS, reach this far? One pixel of
    // soft transition so the disc rim does not alias.
    float w = clamp(s.a * uRadiusPx - distPx + 1.0, 0.0, 1.0);
    sum += s.rgb * w;
    wsum += w;
    maxCoc = max(maxCoc, s.a * w);
  }
  gl_FragColor = vec4(sum / max(1e-4, wsum), max(c0.a, maxCoc));
}`;

// Post-gather smoothing. A 32-tap spiral over a 16 px radius is undersampled at
// the rim, which shows up as mottling in the far field; a CoC-weighted 3x3 tent
// cleans it for ~0.02 ms and leaves sharp regions untouched.
const DOF_FILL_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDof;
uniform vec2 uTexel;
void main() {
  vec4 c = texture2D(tDof, vUv);
  float k = smoothstep(0.06, 0.34, c.a);
  if (k <= 0.001) { gl_FragColor = c; return; }
  vec2 t = uTexel;
  vec4 s = c * 4.0;
  s += (texture2D(tDof, vUv + vec2( t.x, 0.0)) + texture2D(tDof, vUv + vec2(-t.x, 0.0)) +
        texture2D(tDof, vUv + vec2( 0.0, t.y)) + texture2D(tDof, vUv + vec2( 0.0, -t.y))) * 2.0;
  s +=  texture2D(tDof, vUv + vec2( t.x,  t.y)) + texture2D(tDof, vUv + vec2(-t.x,  t.y)) +
        texture2D(tDof, vUv + vec2( t.x, -t.y)) + texture2D(tDof, vUv + vec2(-t.x, -t.y));
  gl_FragColor = mix(c, s / 16.0, k);
}`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tLit;
uniform sampler2D tBloom;
uniform sampler2D tDof;
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform float uBloom;
uniform float uDof;
uniform float uExposure;
uniform float uSaturation;
uniform float uContrast;
uniform float uLift;
uniform float uGamma;
uniform float uGain;
uniform float uVignette;
uniform float uPunch;
uniform float uWarm;
uniform vec3  uWB;        // wave-2: twilight white-balance gains (scene-linear)
uniform float uTonemap;   // 0 = Khronos PBR Neutral, 1 = ACES (hue-blended)
uniform float uKnee;      // display-space highlight shoulder start
uniform float uShadowLift; // luminance bump over the shaded band (asphalt-safe)
uniform float uShadowSat;  // extra chroma over the shaded band
uniform float uVibrance;   // saturation weighted toward muted colours
uniform float uGreenLift;  // luminance gain on yellow-green (grass/foliage)
uniform float uShoulder;   // PBR Neutral: scene-linear peak where compression starts
uniform float uBlackSlope; // PBR Neutral: toe slope at black (0 = Khronos, crushes)
uniform float uBlackOffset; // PBR Neutral: black plateau (0.04 = Khronos)
uniform vec3  uCurve;      // display luma curve: (gamma, toe start, toe end)
uniform float uCurveSat;   // chroma returned to pixels the curve darkened
uniform float uCurveGreen; // fraction of the curve yellow-green (lawn) is spared
uniform vec2  uCurveDip;   // (depth, start) of the upper-mid dip
uniform vec2  uCoolSat;    // (saturation cut on cyan..blue hues, hue-band centre deg)
uniform float uDeepDark;   // round 6: neutral dark (asphalt) value deepen + de-tint
uniform vec2  uAsphalt;    // round 7: (amount, target display luma) neutral-dark flatten
uniform float uNightK;     // night r1: 0 day .. 1 night (fades the daylight asphalt ops)
uniform float uFloorGreen; // r9: floor amount (r8 kernel) for lawn/foliage hues
uniform vec4  uFloor;      // round 8: (peak lift, neutral share, kernel exponent n, 1/peak of y(1-y)^n) shaded-face floor
uniform vec3  uAtmo;      // (strength, startDist, endDist) — aerial perspective
uniform vec4  uGround;    // r9 overview ground key: (amount, y0, y1 world height band, 0)
uniform vec4  uGroundBand; // (display luma lo, hi) where the key reaches full depth; (sat lo, hi) fade-out
uniform vec4  uOrthoBox;   // ortho view box / zoom: (left, right, bottom, top)
uniform vec4  uWorldRowY;  // camera.matrixWorld row 1 (view -> world Y)
uniform vec4  uAbove;      // r12 above-ground key: (on, world Y lo, world Y hi, 0)
uniform float uEdge;      // silhouette ink strength (0 = off)
uniform float uEdgeThr;   // depth step (world units) where the ink starts
uniform float uEdgeR;     // ink tap radius in internal texels (line width)
uniform vec4  uMoonRim;   // night w4r4: (strength, tap radius [internal texels], depth step [world u], 0)
uniform vec3  uMoonRimCol; // night w4r4: display-space colour the rim lifts toward
uniform vec2  uDTexel;    // 1 / depth texture size
uniform float uAspect2;
uniform int   uDebug;     // 0 none, 1 ao, 2 bloom, 3 coc, 4 depth, 5 normals
uniform float uNear;
uniform float uFar;
${COMMON}

const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);

vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFitted(vec3 c) {
  c = ACES_IN * c;
  c = rrtOdtFit(c);
  c = ACES_OUT * c;
  return clamp(c, 0.0, 1.0);
}

// Khronos PBR Neutral (2024). Near-identity below ~0.76 so the authored voxel
// palette reaches the screen unchanged; above that a hue-stable shoulder with
// a touch of desaturation takes highlights to white without a hard clip.
// Yellow-green (lawn / canopy) hue key, shared by greenLift, the curve's
// lawn exemption and the shade floor: hue 55..135 deg (peak ~85), chroma-gated
// so grey concrete never counts.
bool chrOk(vec3 d) { float mx = max(max(d.r, d.g), d.b); return mx == d.g && mx - min(min(d.r, d.g), d.b) > 1e-4; }
float greenKey(vec3 d) {
  float mx = max(max(d.r, d.g), d.b);
  float chr = mx - min(min(d.r, d.g), d.b);
  float h = 60.0 * ((d.b - d.r) / chr + 2.0);
  return smoothstep(55.0, 78.0, h) * (1.0 - smoothstep(100.0, 135.0, h)) * smoothstep(0.08, 0.25, chr / max(mx, 1e-4));
}

vec3 pbrNeutral(vec3 color, float aboveK) {
  float startCompression = uShoulder;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  // Black toe. Khronos' offset (x - 6.25x^2 = 0.04 (2u - u^2), u = x/0.08)
  // has ZERO slope at black: every scene value under ~0.03 lands on ~0 —
  // shaded asphalt and the cars, kerbs and dark sides inside cast shadows all
  // collapsed onto one flat near-black (post critic r6: "shadows drop to
  // near-black, the detail inside them is lost"), and a coloured dark lost its
  // low channels, so shaded sides went muddy. Round 7 generalises it to
  // 0.04 (a u + b u^2 + c u^3) with slope uBlackSlope at black, still meeting
  // the 0.04 plateau at u = 1 with zero slope (1 == the Khronos curve).
  // Round 8: the plateau height is uBlackOffset (Khronos 0.04). A flat
  // 0.04 subtracted from EVERY channel above 0.08 is a big darkening of the
  // lower mids (linear 0.10 -> 0.06: sRGB 89 -> 69) and it strips the low
  // channels of a coloured shade face first, so a shaded blue wall
  // (0.03, 0.06, 0.20) became (0, 0.02, 0.16) = saturated navy (critic r7:
  // "right faces drop to deep navy and brown"). Asphalt (near-neutral)
  // stays where it was: the full Khronos plateau still applies to NEUTRAL
  // darks, and only chromatic pixels (scene-linear sat 0.3 -> 0.6) ease
  // down to uBlackOffset, so it is a hue-keeping toe, not a global lift.
  float cmx = max(color.r, max(color.g, color.b));
  float csat = (cmx - x) / max(cmx, 1e-5);
  // r12: anything ABOVE the ground layer (walls, awnings, props, roofs) also
  // takes the gentle plateau even when it is neutral: a white awning underside
  // or a shaded grey facade is not asphalt (critic r11: "awning undersides and
  // contact shadows crush to near-black"). Roads/ground keep Khronos 0.04.
  // night r1: at night the chroma switch is gated by brightness too — a
  // near-black pixel's saturation is noise, and flipping plateaus on it
  // sparkled the dim fringe of every lamp pool.
  csat *= mix(1.0, smoothstep(0.02, 0.09, cmx), uNightK);
  float bo = max(mix(0.04, uBlackOffset, max(smoothstep(0.3, 0.6, csat), aboveK)), 1e-4);
  float offset = bo;
  if (x < 2.0 * bo) {
    float u = x / (2.0 * bo);
    float a = 2.0 * (1.0 - uBlackSlope);
    offset = bo * u * (a + u * ((3.0 - 2.0 * a) + u * (a - 2.0)));
  }
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return max(color, 0.0);
  float dd = 1.0 - startCompression;
  float newPeak = 1.0 - dd * dd / (peak + dd - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return clamp(mix(color, vec3(newPeak), g), 0.0, 1.0);
}

float zAt(vec2 uv) { return linearDepth(texture2D(tDepth, uv).x, uNear, uFar); }
// Silhouette ink (round 7). ref05 gives every object a thin dark rim where it
// stands in front of something else — roofs over the street, AC units on a
// deck, parked cars on asphalt, one tower in front of the next. Per pixel:
//  1. fit the local depth PLANE from one-sided (min-abs) derivatives, so a
//     pixel right at a silhouette uses its own surface's slope;
//  2. test 16 taps on two rings (uEdgeR and uEdgeR/2 internal texels) against
//     that plane. A tap FARTHER than the plane by > uEdgeThr world units is
//     "behind" — this pixel is on the near rim of a real depth step;
//  3. ink = fraction of taps behind. That fraction ramps smoothly from ~0.5 at
//     the silhouette to 0 one radius in, so the line is anti-aliased and has a
//     constant width in screen px at every zoom and on every edge angle.
// Planes (however steeply they recede), concave creases (wall meets ground:
// the taps come out NEARER) and convex box corners (residual ~R px of world
// size, far under the threshold) all give zero, so there is no halo on the
// ground behind, no line along a wall foot and no line down a tower corner.
float inkK(float R, float thr) {
  float z0 = zAt(vUv);
  vec2 t = uDTexel;
  float zl = zAt(vUv - vec2(t.x, 0.0)), zr = zAt(vUv + vec2(t.x, 0.0));
  float zd = zAt(vUv - vec2(0.0, t.y)), zu = zAt(vUv + vec2(0.0, t.y));
  float gx = abs(zr - z0) < abs(z0 - zl) ? zr - z0 : z0 - zl;
  float gy = abs(zu - z0) < abs(z0 - zd) ? zu - z0 : z0 - zd;
  // Outer ring first; nearly every pixel (plane interiors) exits after it.
  float acc = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.78539816;
    vec2 o = vec2(cos(a), sin(a)) * R;
    float res = zAt(vUv + o * t) - (z0 + gx * o.x + gy * o.y);
    acc += smoothstep(thr, thr * 2.5, res);
  }
  if (acc <= 0.0) return 0.0;
  for (int i = 0; i < 8; i++) {
    float a = (float(i) + 0.5) * 0.78539816;
    vec2 o = vec2(cos(a), sin(a)) * (R * 0.5);
    float res = zAt(vUv + o * t) - (z0 + gx * o.x + gy * o.y);
    acc += smoothstep(thr, thr * 2.5, res);
  }
  return smoothstep(0.0, 0.3, acc * 0.0625);
}

void main() {
  vec4 lit0 = texture2D(tLit, vUv);
  vec3 c = lit0.rgb;
  // Water key (water.js): the pool surface writes scene alpha 0.625 so the
  // grade can spare it the upper-mid dip and the cool-hue saturation cut —
  // together they capped pool blue at ~#1caed6 (ref05's pool is ~#0cbff1).
  // Opaque passes write 1.0 and voxels 0.0, so nothing else lands on 0.625.
  float waterK = 1.0 - smoothstep(0.02, 0.06, abs(lit0.a - 0.625));

  if (uDof > 0.0) {
    vec4 b = texture2D(tDof, vUv);
    // Ramp to a FULL mix by the time the CoC is worth ~3 half-res pixels of
    // bokeh. The old 0.04..0.42 window meant a CoC of 0.3 — the most the tilt
    // band ever produced — was mixed in at 40%, on top of a gather that had
    // already thrown away most of its disc. Two independent attenuations of a
    // blur that then measured as "no change".
    float m = smoothstep(0.02, 0.16, b.a) * uDof;
    c = mix(c, b.rgb, m);
  }
  if (uBloom > 0.0) {
    c += texture2D(tBloom, vUv).rgb * uBloom;
  }
  c *= uWB;   // wave-2: twilight white balance (1,1,1 by day and night)

  // ---- debug taps -------------------------------------------------------
  if (uDebug == 1) { float ao = texture2D(tAO, vUv).r; gl_FragColor = vec4(srgbEncode(vec3(ao)), 1.0); return; }
  if (uDebug == 2) { gl_FragColor = vec4(srgbEncode(texture2D(tBloom, vUv).rgb * uBloom), 1.0); return; }
  if (uDebug == 3) { gl_FragColor = vec4(srgbEncode(vec3(texture2D(tDof, vUv).a)), 1.0); return; }
  if (uDebug == 6) { gl_FragColor = vec4(vec3(1.0 - inkK(uEdgeR, uEdgeThr)), 1.0); return; }
  if (uDebug == 4) {
    float z = linearDepth(texture2D(tDepth, vUv).x, uNear, uFar);
    gl_FragColor = vec4(srgbEncode(vec3(1.0 - exp(-z * 0.004))), 1.0); return;
  }

  // ---- r12 above-ground key ------------------------------------------------
  // World height from depth (ortho only). The asphalt ops below (Khronos black
  // plateau, deepDark, the flat-asphalt pull) exist for ROADS, and the shade
  // floor was gated off every neutral dark to protect them — which also kept a
  // shaded white awning, a grey wall in cast shadow or a contact shadow on a
  // lot near-black (critic r11). aboveK = 1 on anything standing above the
  // ground layer: those darks are not asphalt and take the floor lift.
  float aboveK = 0.0;
  if (uAbove.x > 0.0) {
    float dz = texture2D(tDepth, vUv).x;
    if (dz < 0.999995) {
      float zc = linearDepth(dz, uNear, uFar);
      vec3 vp = vec3(mix(uOrthoBox.x, uOrthoBox.y, vUv.x), mix(uOrthoBox.z, uOrthoBox.w, vUv.y), -zc);
      float wy = dot(uWorldRowY, vec4(vp, 1.0));
      if (uDebug == 7) { gl_FragColor = vec4(clamp(wy * 0.25, 0.0, 1.0), fract(wy * 4.0), 0.0, 1.0); return; }
      aboveK = uAbove.x * smoothstep(uAbove.y, uAbove.z, wy);
    }
    // veg w4: props rocks (scene alpha < -0.5) are knee-high neutral greys —
    // not asphalt. Without this their low shelves / chips took the asphalt
    // pull to ~#151617 and lost the floor lift (ref06 rock faces #8d/#72/#4d).
    if (lit0.a < -0.5) aboveK = uAbove.x;
  }

  // ---- tonemap (scene-linear -> display-linear) -------------------------
  c = max(c * uExposure, 0.0);
  if (uTonemap > 0.5) {
    vec3 tm = acesFitted(c);
    float l = max(1e-4, luma(c));
    vec3 lumTM = acesFitted(vec3(l));
    vec3 hueP = clamp(c / l * lumTM.x, 0.0, 1.0);   // chroma-preserving variant
    c = mix(tm, hueP, uPunch);
  } else {
    c = pbrNeutral(c, aboveK);
  }

  // ---- grade (display space — a pivot of 0.5 only makes sense here) ------
  //
  // CHANNEL-SAFETY INVARIANT: no operation below may drive one channel to zero
  // while its siblings survive. The previous grade broke that twice.
  //
  //   contrast:   (d - 0.5) * k + 0.5 with a hard clamp sends every channel
  //               under 0.5 - 0.5/k to exactly 0. At k = 1.2 that is everything
  //               below 0.083 in DISPLAY sRGB. In a shadowed green pixel R is
  //               the smallest channel, so R alone hit the floor and the pixel
  //               came out as pure toxic green — measured at 5.8% of the whole
  //               frame with R == 0 while G and B survived.
  //   saturation: mix(luma, d, s) is a linear extrapolation away from grey; it
  //               goes negative for any channel with d < g * (1 - 1/s).
  //
  // Both are now ratio-safe. Contrast acts on LUMINANCE and rescales the whole
  // triple, which cannot change the sign of anything. Saturation is limited,
  // per pixel, to the largest factor that leaves the darkest channel at least
  // a quarter of its input value — a limit that is provably never below 1.0,
  // so a requested saturation of 1.0 always applies in full and the guard only
  // engages on pixels that would otherwise have clipped.
  vec3 d = srgbEncode(c);

  d = clamp(d * uGain + uLift * (1.0 - d), 0.0, 1.0);
  d = pow(max(d, 0.0), vec3(1.0 / max(0.05, uGamma)));

  // contrast — luminance driven, ratio preserving
  {
    float y  = luma(d);
    float y2 = clamp((y - 0.5) * uContrast + 0.5, 0.0, 1.0);
    d *= y2 / max(y, 1e-4);
  }

  // saturation — luminance preserving, clip limited
  {
    float y = luma(d);
    vec3 dev = d - vec3(y);
    float minDev = min(min(dev.r, dev.g), dev.b);
    float s = uSaturation;
    // want: y + s*minDev >= K * (y + minDev), i.e. keep K of the darkest
    // channel. With K = 0.25 the bound simplifies to the expression below and
    // is >= 1 for every physically possible (y, minDev).
    if (minDev < -1e-6) s = min(s, (0.75 * y - 0.25 * minDev) / (-minDev));
    d = max(vec3(0.0), vec3(y) + dev * s);
  }

  // ---- colour-keeping shadow side, vibrance, foliage luminance ------------
  // The iso reference keeps its shaded right-hand faces COLOURFUL: a dark
  // orange wall is deep orange, not charcoal. A scene-linear fill light alone
  // cannot do that once the tonemap and sRGB encode have compressed the
  // chroma of every dark value, so the grade restores it in display space.
  // All three ops are ratio-safe (a uniform rescale of the triple, or the
  // same clip-limited saturation as above), so the channel-safety invariant
  // still holds.
  {
    float y = max(luma(d), 1e-4);
    float mx = max(max(d.r, d.g), d.b);
    float mn = min(min(d.r, d.g), d.b);
    float sat = (mx - mn) / max(mx, 1e-4);

    // (1) shadow lift: raise the LUMINANCE of the shaded band (display
    // 0.1..0.5) by a smooth bump that is ~zero at near-black, so asphalt
    // (#1c1d20) stays asphalt and whites are untouched; the triple is scaled
    // as a whole, which keeps hue and chroma ratio.
    float bump = smoothstep(0.11, 0.26, y) * (1.0 - smoothstep(0.34, 0.78, y));
    float y2 = y + uShadowLift * bump * (1.0 - y);
    d *= y2 / y;
    y = y2;

    // (2) vibrance + shadow chroma: extra saturation where colour is weakest
    // (muted pixels, and the shaded band) — a no-op on greys (dev == 0) and on
    // colours that are already strong.
    float wShadow = smoothstep(0.11, 0.22, y) * (1.0 - smoothstep(0.30, 0.64, y));
    float s = 1.0 + uVibrance * (1.0 - sat) * smoothstep(0.08, 0.18, sat)
                  + uShadowSat * wShadow;
    vec3 dev = d - vec3(y);
    float minDev = min(min(dev.r, dev.g), dev.b);
    // Keep 70% of the darkest channel (not 25% as above): this stage runs
    // AFTER the main saturation, and two 25% guards in a row compound to 6%,
    // which rounds a dim channel to 0 in 8 bits. The bound is still >= 1.
    if (minDev < -1e-6) s = min(s, (0.3 * y - 0.7 * minDev) / (-minDev));
    d = max(vec3(0.0), vec3(y) + dev * s);

    // (3) foliage luminance: yellow-green hues (grass, canopies) read lime and
    // sunlit in the reference, not olive. Hue-keyed (60..130 deg, peak ~85),
    // chroma-gated so grey concrete never moves; a pure rescale.
    mx = max(max(d.r, d.g), d.b);
    mn = min(min(d.r, d.g), d.b);
    float chr = mx - mn;
    if (chr > 1e-4 && mx == d.g) {
      float h = 60.0 * ((d.b - d.r) / chr + 2.0);          // 60 yellow .. 180 cyan
      float wh = smoothstep(55.0, 78.0, h) * (1.0 - smoothstep(100.0, 135.0, h));
      float wc = smoothstep(0.08, 0.25, chr / max(mx, 1e-4));
      d *= 1.0 + uGreenLift * wh * wc * (1.0 - smoothstep(0.55, 0.92, mx));
    }
  }

  // tone curve — the round-3 fix for "washed out, no three-tone faces".
  // Runs AFTER the round-2 colour ops so their luma bands (tuned on the
  // un-curved image) still select the same pixels; darkened grass must not
  // fall into the shadowSat band and go acid.
  // A top-anchored display-luma power (f(1) = 1, f'(1) = gamma > 1) with a
  // toe that fades it back to identity below ~0.1: mids come DOWN (ref05 p50
  // 0.55, ours was 0.70) while the upper range is EXPANDED, not compressed —
  // an S-curve pivoted at 0.5 flattens exactly the band where a lit cream wall
  // (0.92) and its shaded side (0.80) live. Asphalt (0.086) is untouched, so no
  // crushed blacks. Ratio-preserving rescale -> channel-safe, hue-stable.
  if (uCurve.x != 1.0 || uCurveDip.x > 0.0) {
    float y  = max(luma(d), 1e-4);
    float gm = 1.0 + (uCurve.x - 1.0) * smoothstep(uCurve.y, uCurve.z, y);
    // Lawn exemption: grass is the frame's biggest TOP face and must stay
    // lime (#9fcb45..#b3d65a), not sink to olive with the building mids.
    // Yellow-green hues (same key as greenLift) keep uCurveGreen of the
    // identity; wall-facing canopy sides still get the rest of the curve.
    float spare = 0.0;
    if (uCurveGreen > 0.0) {
      float mx = max(max(d.r, d.g), d.b);
      float chr = mx - min(min(d.r, d.g), d.b);
      if (chr > 1e-4 && mx == d.g) {
        float h = 60.0 * ((d.b - d.r) / chr + 2.0);
        float wh = smoothstep(55.0, 78.0, h) * (1.0 - smoothstep(100.0, 135.0, h));
        float wc = smoothstep(0.08, 0.25, chr / max(mx, 1e-4));
        spare = uCurveGreen * wh * wc;
        // r6: the exemption is from DARKENING only — a lifting gamma (< 1)
        // brightens lawns with everything else (grass sat below the
        // #9fcb45..#b3d65a target once light deepened its fill).
        if (gm > 1.0) gm = mix(gm, 1.0, spare);
      }
    }
    spare = max(spare, waterK);          // water.js pool: see waterK
    gm = mix(gm, 1.0, waterK);
    float y2 = y < 1.0 ? pow(y, gm) : 1.0 + (y - 1.0) * gm;
    // Upper-mid dip: pulls the band where shaded wall faces sit (display
    // ~0.6..0.85) down while the slope near white rises to ~2, so a lit face
    // and its shaded side separate without darkening the lower mids further.
    // f = y - A * 6.75 u^2 (1-u), u over [t0, 1]: monotone for A < 0.2.
    if (uCurveDip.x > 0.0 && y2 < 1.0) {
      float u = clamp((y2 - uCurveDip.y) / (1.0 - uCurveDip.y), 0.0, 1.0);
      y2 -= uCurveDip.x * (1.0 - spare) * 6.75 * u * u * (1.0 - u);
    }
    d *= y2 / y;
    // Hunt effect: a darker patch reads less colourful at the same chroma
    // ratio, so a face the curve pulled down gets its colour back (the
    // shaded side must stay "colourful, never muddy"). Clip-limited like
    // every saturation op here (keeps 70% of the darkest channel).
    if (uCurveSat > 0.0 && y2 < y) {
      float s = 1.0 + uCurveSat * (1.0 - y2 / y);
      vec3 dev = d - vec3(y2);
      float minDev = min(min(dev.r, dev.g), dev.b);
      if (minDev < -1e-6) s = min(s, max(1.0, (0.3 * y2 - 0.7 * minDev) / (-minDev)));
      d = max(vec3(0.0), vec3(y2) + dev * s);
    }
  }

  // cool-hue restraint: cyan/blue glazing covers a third of a downtown frame
  // and dominated it (critic r2). A hue-keyed, luminance-preserving saturation
  // CUT centred on uCoolSat.y (deg), +/-45 deg wide; greys and warm hues are
  // untouched. A cut can never push a channel negative.
  if (uCoolSat.x > 0.0) {
    float mx = max(max(d.r, d.g), d.b);
    float mn = min(min(d.r, d.g), d.b);
    float chr = mx - mn;
    if (chr > 1e-4) {
      float h;
      if (mx == d.r)      h = 60.0 * mod((d.g - d.b) / chr, 6.0);
      else if (mx == d.g) h = 60.0 * ((d.b - d.r) / chr + 2.0);
      else                h = 60.0 * ((d.r - d.g) / chr + 4.0);
      float w = 1.0 - smoothstep(20.0, 48.0, abs(h - uCoolSat.y));
      float y = luma(d);
      d = vec3(y) + (d - vec3(y)) * (1.0 - uCoolSat.x * w * (1.0 - waterK));
    }
  }

  // Round 6 — deep asphalt. ref05's roads are a flat, neutral ~#161616; ours
  // (sunlit) landed at ~#242429 with a sky-blue cast, which reads as dark
  // GREY and weakens the road/lot/building value hierarchy the critic cited.
  // Low-chroma pixels in display luma ~0.08..0.25 come down by up to
  // uDeepDark (peak ~0.12..0.18) and lose part of their tint. Monotone (the
  // band edges are soft enough that y * (1 - k b(y)) keeps a positive slope),
  // coloured darks (slate roofs, deep reds, shaded foliage) and true blacks
  // are untouched, and the output toe still lifts anything near 0.
  if (uDeepDark > 0.0) {
    float y = max(luma(d), 1e-4);
    float mx = max(max(d.r, d.g), d.b);
    float sat = (mx - min(min(d.r, d.g), d.b)) / max(mx, 1e-4);
    float k = uDeepDark * (1.0 - smoothstep(0.10, 0.24, sat))
            * smoothstep(0.0, 0.04, y) * (1.0 - smoothstep(0.18, 0.32, y)) * (1.0 - aboveK) * (1.0 - uNightK);
    d = vec3(y) + (d - vec3(y)) * (1.0 - 1.5 * k);
    d *= 1.0 - k;
  }

  // Round 7 — flat asphalt. Most of iso-mid's road area is in building shadow
  // and landed at ~16/255 while the sunlit strips sat at ~30; ref05's roads
  // are one flat ~22 with shadows barely hinted (post critic r6: "cast shadows
  // on asphalt drop to near-black"). Low-chroma darks are pulled TOWARD
  // uAsphalt.y by uAsphalt.x: the sun/shadow split on the road halves and the
  // shaded side comes UP, with the slope kept positive (y' = y - k w (y - t),
  // both fades push the right way), so a kerb or manhole in shadow still reads.
  // Coloured darks (cars, deep reds, slate) are exempt via the chroma gate.
  if (uAsphalt.x > 0.0) {
    float y = max(luma(d), 1e-4);
    float mx = max(max(d.r, d.g), d.b);
    float sat = (mx - min(min(d.r, d.g), d.b)) / max(mx, 1e-4);
    float w = uAsphalt.x * (1.0 - smoothstep(0.16, 0.34, sat))
            * smoothstep(0.015, 0.05, y) * (1.0 - smoothstep(0.10, 0.20, y)) * (1.0 - aboveK) * (1.0 - uNightK);
    float y2 = y - w * (y - uAsphalt.y);
    d *= y2 / y;
  }

  // Round 8 — shadow floor (critic r7: "grade too dark and heavy; right
  // faces drop to deep navy and brown; ref05 keeps its darkest building face
  // at ~60-70% of the top face and clearly coloured, light blue-grey or
  // cream"). A luma lift y + A * 6.75 y (1 - y)^2 (exactly A at y = 1/3,
  // ~0 at white, slope >= 1 - 2.25 A everywhere, so monotone for A < 0.44):
  // shaded faces (display 0.2..0.5) come up a lot, lit tops (0.8+) barely
  // move, so the face-to-face ratio opens toward ref05's instead of the
  // whole frame greying. Part of the lift (uFloor.y) is added as NEUTRAL
  // light, which is what sky fill does — a lifted navy face turns light
  // blue-grey, a brown one cream, instead of a brighter saturated navy.
  // Neutral darks (asphalt, display < ~0.16) are gated out so roads stay
  // near-black; coloured darks (a shaded blue tower) are not.
  if (uFloor.x > 0.0 || uFloorGreen > 0.0) {
    float y = max(luma(d), 1e-4);
    float mx = max(max(d.r, d.g), d.b);
    float sat = (mx - min(min(d.r, d.g), d.b)) / max(mx, 1e-4);
    float gate = max(max(smoothstep(0.22, 0.40, sat), smoothstep(0.16, 0.30, y)), aboveK)
               * smoothstep(0.03, 0.10, y);
    float om = 1.0 - min(y, 1.0);
    // r9: kernel y (1-y)^n (n = uFloor.z), normalised to 1 at its peak
    // y = 1/(n+1). n = 2 is the r8 curve; a larger n keeps the lift on the
    // shaded band and off the light upper mids (lawns, paving, kerbs), which
    // the r8 curve raised ~7% and made the overview read pale and hazy.
    // Lawn/foliage hues (the greenLift key) keep the r8 kernel and the full
    // amount at every zoom (uFloorGreen): grass is the frame's biggest top
    // face and must stay lime, not sink to olive with the building mids.
    float lift = uFloor.x * uFloor.w * y * pow(om, uFloor.z);
    if (chrOk(d)) {
      float wg = greenKey(d);
      lift = mix(lift, uFloorGreen * 6.75 * y * om * om, wg);
    }
    float y2 = y + gate * lift;
    float dy = y2 - y;
    d = d * (1.0 + dy / y * (1.0 - uFloor.y)) + vec3(dy * uFloor.y);
  }

  float g = luma(d);

  // Split tone: cool shadows, warm highlights. Purely multiplicative, so it is
  // already channel safe — but do NOT clamp here; the hue-preserving ceiling
  // at the end of the grade handles anything over 1.
  vec3 shadowT = vec3(1.0 - uWarm * 0.7, 1.0 - uWarm * 0.25, 1.0 + uWarm);
  vec3 highT   = vec3(1.0 + uWarm, 1.0 + uWarm * 0.35, 1.0 - uWarm * 0.6);
  d = max(vec3(0.0), d * mix(shadowT, highT, smoothstep(0.15, 0.85, g)));

  // Hue-preserving shoulder + ceiling: the brightest channel rolls off
  // smoothly from uKnee towards 1.0 and the triple is scaled with it, so a
  // saturation/contrast push never flat-clips a white roof or shifts hue.
  {
    float mx = max(max(d.r, d.g), d.b);
    float k = clamp(uKnee, 0.5, 0.999);
    if (mx > k) {
      float w = 1.0 - k;
      float t = mx - k;
      float m2 = k + w * t / (t + w);   // 1st-order continuous, asymptote 1.0
      d *= m2 / mx;
    }
  }

  // ---- aerial perspective (distance desaturation only) -------------------
  // engine.js already drives scene.fog for the colour half of aerial
  // perspective; adding colour here would double up. Losing CHROMA with
  // distance is the part analytic fog does not do, so the two compose.
  // The sky is excluded — it is the reference, not a subject.
  if (uAtmo.x > 0.0) {
    float dz = texture2D(tDepth, vUv).x;
    if (dz < 0.999995) {
      float zc = linearDepth(dz, uNear, uFar);
      float f = smoothstep(uAtmo.y, uAtmo.z, zc) * uAtmo.x;
      d = mix(d, vec3(luma(d)), f);
    }
  }

  // ---- r9 overview ground key --------------------------------------------
  // Critic r8 ('iso' overview): "light grass, light kerbs, lot rims and paving
  // all sit at nearly the same light value; buildings don't stand out from the
  // ground; ref05 has a lower-key ground". At overview scale the ground layer
  // (everything under ~1.2 world units: grass, lot paving and rims, kerbs,
  // sidewalks, parking) comes down in value by up to uGround.x, weighted to
  // its LIGHT values (asphalt, already near-black, does not move) — a ratio
  // rescale, so hue is kept and chroma reads a touch richer. Buildings and
  // roofs are above the band and keep their brightness, so every block
  // separates from its lot the way ref05's do. Water keeps its blue. The
  // zoom factor (JS) makes this exactly zero at iso-mid and closer.
  if (uGround.x > 0.0 && waterK < 0.5) {
    float dz = texture2D(tDepth, vUv).x;
    if (dz < 0.999995) {
      float zc = linearDepth(dz, uNear, uFar);
      vec3 vp = vec3(mix(uOrthoBox.x, uOrthoBox.y, vUv.x), mix(uOrthoBox.z, uOrthoBox.w, vUv.y), -zc);
      float wy = dot(uWorldRowY, vec4(vp, 1.0));
      float y = max(luma(d), 1e-4);
      float mx = max(max(d.r, d.g), d.b);
      float sat = (mx - min(min(d.r, d.g), d.b)) / max(mx, 1e-4);
      // Pale, low-chroma ground (concrete kerbs, rims, paving, sidewalks, a
      // washed-out field) takes the key; saturated lime lawns keep their value,
      // so grass separates from the concrete around it by value as well as hue.
      float k = uGround.x * (1.0 - smoothstep(uGround.y, uGround.z, wy))
              * smoothstep(uGroundBand.x, uGroundBand.y, y)
              * (1.0 - smoothstep(uGroundBand.z, uGroundBand.w, sat))
              * (1.0 - smoothstep(uGround.w, 1.0, y));   // near-white kerb tops stay bright lines
      d *= 1.0 - k;
    }
  }

  // ---- silhouette ink ------------------------------------------------------
  // The reference gets much of its crispness from value separation at object
  // boundaries: every roof rim, sign and prop reads against what is behind it.
  // A depth LAPLACIAN (not a gradient) is zero on any plane however steeply it
  // recedes, and positive only on the NEAR side of a real step, so the ink
  // lands on the object's own rim — never as a halo on the ground behind it,
  // and never on the continuous wall-meets-ground seam (that is AO's job).
  // Drawn at the supersampled internal resolution, so it resolves to a soft
  // sub-pixel line rather than a stair-stepped one. Ratio-preserving multiply.
  // veg r14: props.js vegetation (scene alpha = uPropVegSsao 0.2) takes no
  // ink — ref06 canopies have clean edges (critic r13: "thin dark outline").
  if (uEdge > 0.0) d *= 1.0 - uEdge * inkK(uEdgeR, uEdgeThr) * smoothstep(0.04, 0.08, abs(lit0.a - 0.2));

  // ---- NIGHT w4r4: moonlit silhouette rim ---------------------------------
  // Critics w4r1..r3 (all three): at night unlit masses share one dark value,
  // so one building no longer separates from the next or from the street;
  // "edges should be crisp and light" (ref05 carries every mass with a light
  // roof rim). The same depth-laplacian test as the ink finds the NEAR side of
  // every real depth step (roof edge over the street, tower in front of the
  // next, parapet over its deck) and lifts it toward a pale moon blue — a thin
  // light line on the object's own rim, never a halo on what is behind it.
  // Max-blend: lit windows / neon never dim. Vegetation (alpha 0.2) and water
  // are spared. Day: uMoonRim.x = 0, the taps are skipped.
  if (uMoonRim.x > 0.0) {
    float mk = inkK(uMoonRim.y, uMoonRim.z) * smoothstep(0.04, 0.08, abs(lit0.a - 0.2)) * (1.0 - waterK);
    if (mk > 0.0) d = max(d, mix(d, uMoonRimCol, uMoonRim.x * mk));
  }

  // ---- vignette (off by default; kept for photo-mode) --------------------
  if (uVignette > 0.0) {
    vec2 vd = (vUv - 0.5) * vec2(uAspect2, 1.0);
    d *= 1.0 - uVignette * smoothstep(0.28, 0.82, dot(vd, vd) * 1.55);
  }

  gl_FragColor = vec4(clamp(d, 0.0, 1.0), 1.0);
}`;

// FXAA 3.11, quality preset 39 (12 search steps). Operates on sRGB-encoded LDR.
const FXAA_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uRcp;               // 1 / resolution
uniform float uSubpix;
uniform float uEdgeThreshold;
uniform float uEdgeThresholdMin;

float fl(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float fq(int i) {
  if (i < 5) return 1.0;
  if (i == 5) return 1.5;
  if (i < 10) return 2.0;
  if (i == 10) return 4.0;
  return 8.0;
}

void main() {
  vec2 posM = vUv;
  vec4 rgbyM = texture2D(tSrc, posM);
  float lumaM = fl(rgbyM.rgb);
  float lumaS = fl(texture2D(tSrc, posM + vec2( 0.0,  uRcp.y)).rgb);
  float lumaE = fl(texture2D(tSrc, posM + vec2( uRcp.x, 0.0)).rgb);
  float lumaN = fl(texture2D(tSrc, posM + vec2( 0.0, -uRcp.y)).rgb);
  float lumaW = fl(texture2D(tSrc, posM + vec2(-uRcp.x, 0.0)).rgb);

  float maxSM = max(lumaS, lumaM);
  float minSM = min(lumaS, lumaM);
  float maxESM = max(lumaE, maxSM);
  float minESM = min(lumaE, minSM);
  float maxWN = max(lumaN, lumaW);
  float minWN = min(lumaN, lumaW);
  float rangeMax = max(maxWN, maxESM);
  float rangeMin = min(minWN, minESM);
  float range = rangeMax - rangeMin;
  float rangeMaxClamped = max(uEdgeThresholdMin, rangeMax * uEdgeThreshold);
  if (range < rangeMaxClamped) { gl_FragColor = rgbyM; return; }

  float lumaNW = fl(texture2D(tSrc, posM + vec2(-uRcp.x, -uRcp.y)).rgb);
  float lumaSE = fl(texture2D(tSrc, posM + vec2( uRcp.x,  uRcp.y)).rgb);
  float lumaNE = fl(texture2D(tSrc, posM + vec2( uRcp.x, -uRcp.y)).rgb);
  float lumaSW = fl(texture2D(tSrc, posM + vec2(-uRcp.x,  uRcp.y)).rgb);

  float lumaNS = lumaN + lumaS;
  float lumaWE = lumaW + lumaE;
  float subpixRcpRange = 1.0 / range;
  float subpixNSWE = lumaNS + lumaWE;
  float edgeHorz1 = (-2.0 * lumaM) + lumaNS;
  float edgeVert1 = (-2.0 * lumaM) + lumaWE;

  float lumaNESE = lumaNE + lumaSE;
  float lumaNWNE = lumaNW + lumaNE;
  float edgeHorz2 = (-2.0 * lumaE) + lumaNESE;
  float edgeVert2 = (-2.0 * lumaN) + lumaNWNE;

  float lumaNWSW = lumaNW + lumaSW;
  float lumaSWSE = lumaSW + lumaSE;
  float edgeHorz4 = (abs(edgeHorz1) * 2.0) + abs(edgeHorz2);
  float edgeVert4 = (abs(edgeVert1) * 2.0) + abs(edgeVert2);
  float edgeHorz3 = (-2.0 * lumaW) + lumaNWSW;
  float edgeVert3 = (-2.0 * lumaS) + lumaSWSE;
  float edgeHorz = abs(edgeHorz3) + edgeHorz4;
  float edgeVert = abs(edgeVert3) + edgeVert4;

  float subpixNWSWNESE = lumaNWSW + lumaNESE;
  float lengthSign = uRcp.x;
  bool horzSpan = edgeHorz >= edgeVert;
  float subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;

  if (!horzSpan) lumaN = lumaW;
  if (!horzSpan) lumaS = lumaE;
  if (horzSpan) lengthSign = uRcp.y;
  float subpixB = (subpixA * (1.0 / 12.0)) - lumaM;

  float gradientN = lumaN - lumaM;
  float gradientS = lumaS - lumaM;
  float lumaNN = lumaN + lumaM;
  float lumaSS = lumaS + lumaM;
  bool pairN = abs(gradientN) >= abs(gradientS);
  float gradient = max(abs(gradientN), abs(gradientS));
  if (pairN) lengthSign = -lengthSign;
  float subpixC = clamp(abs(subpixB) * subpixRcpRange, 0.0, 1.0);

  vec2 posB = posM;
  vec2 offNP;
  offNP.x = (!horzSpan) ? 0.0 : uRcp.x;
  offNP.y = ( horzSpan) ? 0.0 : uRcp.y;
  if (!horzSpan) posB.x += lengthSign * 0.5;
  if ( horzSpan) posB.y += lengthSign * 0.5;

  vec2 posN = posB - offNP * fq(0);
  vec2 posP = posB + offNP * fq(0);
  float subpixD = ((-2.0) * subpixC) + 3.0;
  float lumaEndN = fl(texture2D(tSrc, posN).rgb);
  float subpixE = subpixC * subpixC;
  float lumaEndP = fl(texture2D(tSrc, posP).rgb);

  if (!pairN) lumaNN = lumaSS;
  float gradientScaled = gradient * 0.25;
  float lumaMM = lumaM - lumaNN * 0.5;
  float subpixF = subpixD * subpixE;
  bool lumaMLTZero = lumaMM < 0.0;

  lumaEndN -= lumaNN * 0.5;
  lumaEndP -= lumaNN * 0.5;
  bool doneN = abs(lumaEndN) >= gradientScaled;
  bool doneP = abs(lumaEndP) >= gradientScaled;
  if (!doneN) posN -= offNP * fq(1);
  if (!doneP) posP += offNP * fq(1);
  bool doneNP = (!doneN) || (!doneP);

  for (int i = 2; i < 12; i++) {
    if (!doneNP) break;
    if (!doneN) lumaEndN = fl(texture2D(tSrc, posN).rgb) - lumaNN * 0.5;
    if (!doneP) lumaEndP = fl(texture2D(tSrc, posP).rgb) - lumaNN * 0.5;
    doneN = abs(lumaEndN) >= gradientScaled;
    doneP = abs(lumaEndP) >= gradientScaled;
    if (!doneN) posN -= offNP * fq(i);
    if (!doneP) posP += offNP * fq(i);
    doneNP = (!doneN) || (!doneP);
  }

  float dstN = horzSpan ? (posM.x - posN.x) : (posM.y - posN.y);
  float dstP = horzSpan ? (posP.x - posM.x) : (posP.y - posM.y);
  bool goodSpanN = (lumaEndN < 0.0) != lumaMLTZero;
  float spanLength = dstP + dstN;
  bool goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;
  float spanLengthRcp = 1.0 / max(1e-6, spanLength);
  bool directionN = dstN < dstP;
  float dst = min(dstN, dstP);
  bool goodSpan = directionN ? goodSpanN : goodSpanP;
  float subpixG = subpixF * subpixF;
  float pixelOffset = (dst * (-spanLengthRcp)) + 0.5;
  float subpixH = subpixG * uSubpix;
  float pixelOffsetGood = goodSpan ? pixelOffset : 0.0;
  float pixelOffsetSubpix = max(pixelOffsetGood, subpixH);
  if (!horzSpan) posM.x += pixelOffsetSubpix * lengthSign;
  if ( horzSpan) posM.y += pixelOffsetSubpix * lengthSign;

  gl_FragColor = vec4(texture2D(tSrc, posM).rgb, rgbyM.a);
}`;

// AMD FidelityFX CAS. Runs BEFORE the AA resolve by default (see the ordering
// note at the top of the file): CAS after FXAA re-hardens exactly the steps
// FXAA has just resolved, and it amplifies whatever 1-pixel-period content is
// in the frame — measured here at roughly +85% high-frequency energy when it
// runs last.
const CAS_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;     // sRGB-encoded LDR
uniform vec2 uRcp;
uniform float uSharpen;

void main() {
  vec3 e = texture2D(tSrc, vUv).rgb;
  if (uSharpen <= 0.0) { gl_FragColor = vec4(e, 1.0); return; }

  vec3 a = texture2D(tSrc, vUv + vec2(-uRcp.x, -uRcp.y)).rgb;
  vec3 b = texture2D(tSrc, vUv + vec2( 0.0,   -uRcp.y)).rgb;
  vec3 c = texture2D(tSrc, vUv + vec2( uRcp.x, -uRcp.y)).rgb;
  vec3 d = texture2D(tSrc, vUv + vec2(-uRcp.x,  0.0)).rgb;
  vec3 f = texture2D(tSrc, vUv + vec2( uRcp.x,  0.0)).rgb;
  vec3 g = texture2D(tSrc, vUv + vec2(-uRcp.x,  uRcp.y)).rgb;
  vec3 h = texture2D(tSrc, vUv + vec2( 0.0,     uRcp.y)).rgb;
  vec3 i = texture2D(tSrc, vUv + vec2( uRcp.x,  uRcp.y)).rgb;

  vec3 mn = min(min(min(d, e), min(f, b)), h);
  vec3 mn2 = min(min(min(a, c), min(g, i)), mn);
  mn += mn2;
  vec3 mx = max(max(max(d, e), max(f, b)), h);
  vec3 mx2 = max(max(max(a, c), max(g, i)), mx);
  mx += mx2;

  vec3 rcpMx = 1.0 / max(mx, vec3(1e-4));
  vec3 amp = clamp(min(mn, 2.0 - mx) * rcpMx, 0.0, 1.0);
  amp = sqrt(amp);
  float peak = -1.0 / mix(8.0, 5.0, clamp(uSharpen, 0.0, 1.0));
  vec3 w = amp * peak;
  vec3 rcpW = 1.0 / (1.0 + 4.0 * w);
  gl_FragColor = vec4(clamp((b * w + d * w + f * w + h * w + e) * rcpW, 0.0, 1.0), 1.0);
}`;

// Separable supersampling resolve. One axis per pass; uDir selects it. For an
// output texel centre the source centre is at (x_out * uScale); every source
// texel within 2 output pixels contributes with a Mitchell-Netravali weight of
// its distance measured in OUTPUT pixels. Samples land on exact source texel
// centres, so bilinear filtering never mixes neighbours behind our back.
// Up to uScale 1.75 the support is 7 taps; the loop runs 9.
const SS_RESOLVE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uSrcSize;     // source size in texels
uniform vec2 uDir;         // (1,0) horizontal or (0,1) vertical
uniform float uScale;      // source texels per output pixel along uDir
uniform float uB;
uniform float uC;

float mitchell(float x) {
  x = abs(x);
  if (x < 1.0) return ((12.0 - 9.0 * uB - 6.0 * uC) * x * x * x
                     + (-18.0 + 12.0 * uB + 6.0 * uC) * x * x + (6.0 - 2.0 * uB)) / 6.0;
  if (x < 2.0) return ((-uB - 6.0 * uC) * x * x * x + (6.0 * uB + 30.0 * uC) * x * x
                     + (-12.0 * uB - 48.0 * uC) * x + (8.0 * uB + 24.0 * uC)) / 6.0;
  return 0.0;
}

void main() {
  float srcLen = dot(uSrcSize, uDir);
  float pos = dot(vUv, uDir) * srcLen;             // source texel-space position
  float i0 = floor(pos - 0.5);                      // nearest centre at/below
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int k = -4; k <= 4; k++) {
    float i = i0 + float(k);
    float ci = clamp(i, 0.0, srcLen - 1.0);
    float w = mitchell((i + 0.5 - pos) / uScale);
    if (w == 0.0) continue;
    vec2 uv = vUv;
    if (uDir.x > 0.5) uv.x = (ci + 0.5) / srcLen; else uv.y = (ci + 0.5) / srcLen;
    sum += texture2D(tSrc, uv).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(clamp(sum / max(1e-4, wsum), 0.0, 1.0), 1.0);
}`;

// r11 crisp pass: separable Gaussian of display LUMA (13 taps, uStep uv per
// tap, uSigma in taps). uLumaIn 1 = source is the RGB frame (take its luma),
// 0 = source already holds luma in .r. Output luma in .r.
const LUMA_BLUR_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uStep;
uniform float uSigma;
uniform float uLumaIn;
float tapY(vec2 uv) {
  vec3 c = texture2D(tSrc, uv).rgb;
  return uLumaIn > 0.5 ? dot(c, vec3(0.2126, 0.7152, 0.0722)) : c.r;
}
void main() {
  float s2 = 1.0 / (2.0 * uSigma * uSigma);
  float sum = 0.0, wsum = 0.0;
  for (int k = -6; k <= 6; k++) {
    float fk = float(k);
    float w = exp(-fk * fk * s2);
    sum += tapY(vUv + uStep * fk) * w;
    wsum += w;
  }
  float y = sum / wsum;
  gl_FragColor = vec4(y, y, y, 1.0);
}`;

// Final output: optional trailing CAS (only when sharpen.beforeAA === false)
// plus the raw/post A-B split wipe.
const OUTPUT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;     // sRGB-encoded LDR
uniform sampler2D tRaw;     // linear HDR scene, for the A/B split
uniform vec2 uRcp;
uniform float uSharpen;
uniform float uSplit;
uniform vec4 uUsm;          // x fine amount (3x3), y edge-contrast amount (ring), z ring radius px, w overshoot
uniform vec2 uUsmCore;      // 3x3 luma range: no sharpening below x, full above y
uniform vec2 uToe;          // x lift at black, y display luma where the toe ends (0 = off)
uniform vec4 uDetail;       // x small-feature chroma cut, y luma pull, z ring radius (device px)
uniform vec4 uDetailSim;    // x,y colour distance: similar below x, different above y; z,w similarity band
uniform sampler2D tBlurF;   // r11 crisp: luma blurred at sigmaFine (CSS res)
uniform sampler2D tBlurM;   // r11 crisp: luma blurred at sigmaMid (half CSS res)
uniform vec4 uCrisp;        // x fine amount, y mid amount, z limit fine, w limit mid
uniform vec2 uCrispCore;    // coring: |band| under x untouched, full from y
uniform vec2 uCrispClamp;   // w4r1: x tap distance (device px, 0 = off), y overshoot fraction of the local range
${COMMON}
float crispBand(float x, float lim) {
  float a = abs(x);
  x *= smoothstep(uCrispCore.x, uCrispCore.y, a);
  return x / (1.0 + abs(x) / max(lim, 1e-4));
}

float usmY(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 dTap(vec2 o) { return texture2D(tSrc, vUv + o).rgb; }
float dSim(vec3 c, vec3 t) { return 1.0 - smoothstep(uDetailSim.x, uDetailSim.y, length(t - c)); }
// 1 when c is (close to) a mix of two clearly different neighbours a and b.
float dBlend(vec3 c, vec3 a, vec3 b) {
  vec3 ab = b - a;
  float L2 = dot(ab, ab);
  if (L2 < 0.02) return 0.0;
  float t = clamp(dot(c - a, ab) / L2, 0.0, 1.0);
  float off = length(c - (a + ab * t));
  return (1.0 - smoothstep(0.03, 0.07, off)) * smoothstep(0.02, 0.06, L2);
}

void main() {
  vec3 e = texture2D(tSrc, vUv).rgb;
  vec3 outc = e;

  // Round 6 — small-feature chroma restraint (see params.detail). Similarity
  // of this pixel's colour to 16 taps on two rings (radius R and R/2): ~1 on
  // a big face, ~0.55 on a straight edge between two big faces, ~0 on a
  // feature smaller than the ring (a window, sign, AC unit, prop at far
  // zoom). Only the latter loses saturation — a luminance-preserving cut
  // toward its own grey, so there is no colour bleed from the neighbours.
  if (uDetail.x > 0.0 || uDetail.y > 0.0) {
    vec2 R = uRcp * uDetail.z;
    vec2 Rd = R * 0.7071;
    vec2 H = R * 0.5;
    vec2 Hd = Rd * 0.5;
    vec3 t0 = dTap(vec2( R.x, 0.0)), t1 = dTap(vec2(-R.x, 0.0)), t2 = dTap(vec2(0.0,  R.y)), t3 = dTap(vec2(0.0, -R.y));
    vec3 t4 = dTap(Rd), t5 = dTap(-Rd), t6 = dTap(vec2(Rd.x, -Rd.y)), t7 = dTap(vec2(-Rd.x, Rd.y));
    vec3 h0 = dTap(vec2( H.x, 0.0)), h1 = dTap(vec2(-H.x, 0.0)), h2 = dTap(vec2(0.0,  H.y)), h3 = dTap(vec2(0.0, -H.y));
    vec3 h4 = dTap(Hd), h5 = dTap(-Hd), h6 = dTap(vec2(Hd.x, -Hd.y)), h7 = dTap(vec2(-Hd.x, Hd.y));
    float S = dSim(e, t0) + dSim(e, t1) + dSim(e, t2) + dSim(e, t3) + dSim(e, t4) + dSim(e, t5) + dSim(e, t6) + dSim(e, t7)
            + dSim(e, h0) + dSim(e, h1) + dSim(e, h2) + dSim(e, h3) + dSim(e, h4) + dSim(e, h5) + dSim(e, h6) + dSim(e, h7);
    // Anti-aliased edge guard: a pixel on the edge between two big faces is
    // unlike both sides too, but its colour lies on the segment between its
    // 1-px neighbours across the edge. Without this guard those blend pixels
    // were modified unevenly along an edge, which ragged it (coordinator
    // 16:50, one-bakery). Real small features (a 1-px window line has the
    // SAME colour on both sides) are not blends and keep their weight.
    float blend = 0.0;
    blend = max(blend, dBlend(e, dTap(vec2(-uRcp.x, 0.0)), dTap(vec2(uRcp.x, 0.0))));
    blend = max(blend, dBlend(e, dTap(vec2(0.0, -uRcp.y)), dTap(vec2(0.0, uRcp.y))));
    blend = max(blend, dBlend(e, dTap(-uRcp), dTap(uRcp)));
    blend = max(blend, dBlend(e, dTap(vec2(-uRcp.x, uRcp.y)), dTap(vec2(uRcp.x, -uRcp.y))));
    float w = (1.0 - smoothstep(uDetailSim.z, uDetailSim.w, S / 16.0)) * (1.0 - blend);
    float y = usmY(e);
    vec3 dev = e - vec3(y);
    e = vec3(y) + dev * (1.0 - uDetail.x * w);
    if (uDetail.y > 0.0) {
      float ym = usmY(t0 + t1 + t2 + t3 + t4 + t5 + t6 + t7 + h0 + h1 + h2 + h3 + h4 + h5 + h6 + h7) / 16.0;
      // Only COLOURED specks (windows, props, signage) are pulled: neutral
      // detail — white road dashes, zebra stripes, kerbs — keeps full value.
      float mxc = max(max(e.r, e.g), e.b);
      float sc = (mxc - min(min(e.r, e.g), e.b)) / max(mxc, 1e-4);
      float yn = mix(y, ym, uDetail.y * w * smoothstep(0.12, 0.35, sc));
      e *= yn / max(y, 1e-4);
    }
    e = clamp(e, 0.0, 1.0);
    outc = e;
  }

  // Round 4 — display-space luma unsharp mask ("crisp edge to edge"). ref05 is
  // a visibly sharpened render: its 99th-percentile 1-px luma step is ~0.53
  // against our 0.41 on a comparable-density frame. Two detail bands:
  //   fine: pixel - 3x3 binomial blur (acutance on every voxel edge)
  //   ring: pixel - mean of 8 taps at uUsm.z px (value separation between a
  //         facade and the road/lot next to it — the critic's "punch")
  // Both are HALO-CLAMPED to the pixel's own 3x3 min/max (+ uUsm.w x range):
  // on a flat face or open lawn the range is ~0, so nothing can be drawn
  // there — no rims on grass, no ringing on kerbs. Applied as a luma RATIO so
  // hue and saturation are untouched, with a hue-preserving roll-off at 1.0.
  if (uUsm.x > 0.0 || uUsm.y > 0.0) {
    float ye = usmY(e);
    float y1 = usmY(texture2D(tSrc, vUv + vec2(-uRcp.x, -uRcp.y)).rgb);
    float y2 = usmY(texture2D(tSrc, vUv + vec2( 0.0,    -uRcp.y)).rgb);
    float y3 = usmY(texture2D(tSrc, vUv + vec2( uRcp.x, -uRcp.y)).rgb);
    float y4 = usmY(texture2D(tSrc, vUv + vec2(-uRcp.x,  0.0)).rgb);
    float y6 = usmY(texture2D(tSrc, vUv + vec2( uRcp.x,  0.0)).rgb);
    float y7 = usmY(texture2D(tSrc, vUv + vec2(-uRcp.x,  uRcp.y)).rgb);
    float y8 = usmY(texture2D(tSrc, vUv + vec2( 0.0,     uRcp.y)).rgb);
    float y9 = usmY(texture2D(tSrc, vUv + vec2( uRcp.x,  uRcp.y)).rgb);
    float mn = min(min(min(y1, y2), min(y3, y4)), min(min(y6, y7), min(min(y8, y9), ye)));
    float mx = max(max(max(y1, y2), max(y3, y4)), max(max(y6, y7), max(max(y8, y9), ye)));
    float yb = (4.0 * ye + 2.0 * (y2 + y4 + y6 + y8) + (y1 + y3 + y7 + y9)) / 16.0;
    float yr = ye;
    if (uUsm.y > 0.0) {
      vec2 R = uRcp * uUsm.z;
      vec2 Rd = R * 0.7071;
      yr = 0.125 * (
        usmY(texture2D(tSrc, vUv + vec2( R.x, 0.0)).rgb) + usmY(texture2D(tSrc, vUv + vec2(-R.x, 0.0)).rgb) +
        usmY(texture2D(tSrc, vUv + vec2(0.0,  R.y)).rgb) + usmY(texture2D(tSrc, vUv + vec2(0.0, -R.y)).rgb) +
        usmY(texture2D(tSrc, vUv + Rd).rgb) + usmY(texture2D(tSrc, vUv - Rd).rgb) +
        usmY(texture2D(tSrc, vUv + vec2(Rd.x, -Rd.y)).rgb) + usmY(texture2D(tSrc, vUv + vec2(-Rd.x, Rd.y)).rgb));
    }
    // Coring: only real edges get sharpened. Faint low-contrast marks (a
    // lawn's shading ripples, paving speckle, AO ghosts from other passes:
    // 3x3 range ~0.02-0.09) stay as soft as they came in; a voxel edge,
    // kerb or window frame (range 0.15+) gets the full amount.
    float core = smoothstep(uUsmCore.x, uUsmCore.y, mx - mn);
    float yo = ye + core * (uUsm.x * (ye - yb) + uUsm.y * (ye - yr));
    float m = uUsm.w * (mx - mn);
    yo = clamp(yo, mn - m, mx + m);
    // Soft headroom on the delta (Reinhard on d against the room left): a
    // bright face can approach but never flat-clip to white, and near-black
    // asphalt cannot be crushed to 0 (ref05's p1 is ~0.06, not 0).
    float d = yo - ye;
    float room = d > 0.0 ? (1.0 - ye) : ye;
    d = d * room / max(room + abs(d), 1e-4);
    yo = ye + d;
    vec3 c = ye > 0.03 ? e * (yo / ye) : e + (yo - ye);
    float cm = max(c.r, max(c.g, c.b));
    if (cm > 1.0) c = yo + (c - yo) * ((1.0 - yo) / max(cm - yo, 1e-4));
    outc = clamp(c, 0.0, 1.0);
    e = outc;
  }

  // r11 — crisp: two-band cored, soft-limited luma USM (see params.crisp).
  if (uCrisp.x > 0.0 || uCrisp.y > 0.0) {
    // Bands are measured on the frame the blurs were built from (tSrc), then
    // applied to the pixel as it stands after the detail pass above.
    float y0 = usmY(texture2D(tSrc, vUv).rgb);
    float yf = texture2D(tBlurF, vUv).r;
    float ym = texture2D(tBlurM, vUv).r;
    float dF = uCrisp.x * crispBand(y0 - yf, uCrisp.z);
    float dM = uCrisp.y * crispBand(yf - ym, uCrisp.w);
    float d = dF + dM;
    float ye = usmY(e);
    // Headroom (as the USM above): a lit face approaches white but never
    // flat-clips; near-black asphalt cannot be crushed to 0.
    float room = d > 0.0 ? (1.0 - ye) : ye;
    float hk = room / max(room + abs(d), 1e-4);
    d *= hk;
    float yo = ye + d;
    // w4r1 halo clamp (fine band only; see params.crisp.overshoot).
    if (uCrispClamp.x > 0.0) {
      vec2 o = uRcp * uCrispClamp.x;
      float l1 = usmY(texture2D(tSrc, vUv + vec2( o.x, 0.0)).rgb), l2 = usmY(texture2D(tSrc, vUv + vec2(-o.x, 0.0)).rgb);
      float l3 = usmY(texture2D(tSrc, vUv + vec2(0.0,  o.y)).rgb), l4 = usmY(texture2D(tSrc, vUv + vec2(0.0, -o.y)).rgb);
      float l5 = usmY(texture2D(tSrc, vUv + o).rgb),               l6 = usmY(texture2D(tSrc, vUv - o).rgb);
      float l7 = usmY(texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb), l8 = usmY(texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb);
      float lmn = min(min(min(l1, l2), min(l3, l4)), min(min(l5, l6), min(min(l7, l8), y0)));
      float lmx = max(max(max(l1, l2), max(l3, l4)), max(max(l5, l6), max(max(l7, l8), y0)));
      float ov = uCrispClamp.y * (lmx - lmn);
      // the detail pass may have moved e off y0: clamp the CHANGE, in e's frame
      float dm = dM * hk;
      float lo = ye + (lmn - ov - y0) + min(dm, 0.0);
      float hi = ye + (lmx + ov - y0) + max(dm, 0.0);
      yo = clamp(yo, min(lo, ye), max(hi, ye));
    }
    vec3 c = ye > 0.03 ? e * (yo / ye) : e + (yo - ye);
    float cm = max(c.r, max(c.g, c.b));
    if (cm > 1.0) c = yo + (c - yo) * ((1.0 - yo) / max(cm - yo, 1e-4));
    e = clamp(c, 0.0, 1.0);
    outc = e;
  }

  if (uSharpen > 0.0) {
    vec3 a = texture2D(tSrc, vUv + vec2(-uRcp.x, -uRcp.y)).rgb;
    vec3 b = texture2D(tSrc, vUv + vec2( 0.0,   -uRcp.y)).rgb;
    vec3 c = texture2D(tSrc, vUv + vec2( uRcp.x, -uRcp.y)).rgb;
    vec3 d = texture2D(tSrc, vUv + vec2(-uRcp.x,  0.0)).rgb;
    vec3 f = texture2D(tSrc, vUv + vec2( uRcp.x,  0.0)).rgb;
    vec3 g = texture2D(tSrc, vUv + vec2(-uRcp.x,  uRcp.y)).rgb;
    vec3 h = texture2D(tSrc, vUv + vec2( 0.0,     uRcp.y)).rgb;
    vec3 i = texture2D(tSrc, vUv + vec2( uRcp.x,  uRcp.y)).rgb;

    vec3 mn = min(min(min(d, e), min(f, b)), h);
    vec3 mn2 = min(min(min(a, c), min(g, i)), mn);
    mn += mn2;
    vec3 mx = max(max(max(d, e), max(f, b)), h);
    vec3 mx2 = max(max(max(a, c), max(g, i)), mx);
    mx += mx2;

    vec3 rcpMx = 1.0 / max(mx, vec3(1e-4));
    vec3 amp = clamp(min(mn, 2.0 - mx) * rcpMx, 0.0, 1.0);
    amp = sqrt(amp);
    float peak = -1.0 / mix(8.0, 5.0, clamp(uSharpen, 0.0, 1.0));
    vec3 w = amp * peak;
    vec3 rcpW = 1.0 / (1.0 + 4.0 * w);
    outc = clamp((b * w + d * w + f * w + h * w + e) * rcpW, 0.0, 1.0);
  }

  // Display-space toe (round 5). SSAO on buildings + contrast + ink drove
  // 4.4% of iso-mid below 8/255 (ref05: 0.3% — its darkest pixels sit at
  // ~15-20). y' = y + a (1 - y/y0)^2 below y0: black -> a, asphalt (~0.1)
  // moves < 1/255, slope >= 1 - 2a/y0 > 0 (monotone). Applied as a capped
  // luma ratio (hue kept) plus a grey remainder for true black.
  if (uToe.x > 0.0) {
    float y = luma(outc);
    if (y < uToe.y) {
      float t = 1.0 - y / uToe.y;
      float y2 = y + uToe.x * t * t;
      float k = min(y2 / max(y, 1e-4), 1.6);
      outc = outc * k + vec3(max(0.0, y2 - y * k));
    }
  }

  if (uSplit > 0.0) {
    if (vUv.x < uSplit) {
      outc = srgbEncode(texture2D(tRaw, vUv).rgb);
    } else if (vUv.x < uSplit + uRcp.x * 1.5) {
      outc = vec3(1.0, 0.85, 0.2);
    }
  }

  gl_FragColor = vec4(outc, 1.0);
}`;

// ---------------------------------------------------------------------------
// PostFX
// ---------------------------------------------------------------------------

export class PostFX {
  constructor(renderer, scene, camera, opts = {}) {
    if (!renderer) throw new Error('PostFX: renderer is required');
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.params = defaultParams();
    if (opts.params) this.setParams(opts.params);

    this._quality = clamp(opts.quality === undefined ? 2 : opts.quality | 0, 0, 2);
    this._q = QUALITY_TABLE[this._quality];

    const caps = renderer.capabilities;
    this._webgl2 = !!caps.isWebGL2;
    const ext = renderer.extensions;
    this._hdrOK = this._webgl2 &&
      (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'));
    this._hdrType = this._hdrOK ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this._maxSamples = this._webgl2 ? (caps.maxSamples || 0) : 0;

    this._w = 1; this._h = 1; this._pr = 1;

    // Fullscreen triangle.
    this._fsGeo = new THREE.BufferGeometry();
    this._fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this._fsGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this._fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._fsMesh = new THREE.Mesh(this._fsGeo, null);
    this._fsMesh.frustumCulled = false;
    this._fsScene = new THREE.Scene();
    this._fsScene.add(this._fsMesh);

    this._targets = [];       // every RT we own, for leak accounting
    this._materials = [];

    this._buildKernel();
    this._buildMaterials();

    const w = opts.width || 1, h = opts.height || 1;
    this.setSize(w, h, opts.pixelRatio || 1);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  _buildKernel() {
    // Deterministic cosine-ish hemisphere kernel, clustered near the origin.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed |= 0;
      return ((seed >>> 0) / 4294967296);
    };
    this._kernel = [];
    for (let i = 0; i < 16; i++) {
      const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 0.9 + 0.1);
      v.normalize();
      let s = i / 16;
      s = 0.25 + 0.75 * s * s;
      v.multiplyScalar(s);
      this._kernel.push(v);
    }
  }

  _mat(frag, uniforms, extra) {
    const m = new THREE.ShaderMaterial(Object.assign({
      vertexShader: VERT,
      fragmentShader: frag,
      uniforms: Object.assign({ uOrthoCam: { value: 0 } }, uniforms),
      depthTest: false,
      depthWrite: false,
    }, extra || {}));
    this._materials.push(m);
    return m;
  }

  _buildMaterials() {
    const U = (v) => ({ value: v });

    this.mSSAO = this._mat(SSAO_FRAG, {
      tDepth: U(null), uTexel: U(new THREE.Vector2()), uAOSize: U(new THREE.Vector2(1, 1)),
      uKernel: U(this._kernel), uSamples: U(12),
      uRadius: U(4.5), uContactRadius: U(0.95), uBias: U(0.025),
      uCanyonRadius: U(6.0), uCanyonIntensity: U(0.0),
      uIntensity: U(0.5), uContactIntensity: U(1.6),
      uPower: U(1.3), uContactPower: U(1.15),
      uMinPixels: U(2.5), uMaxPixels: U(72.0), uPlaneBias: U(0.05),
      uTanHalfFov: U(0.36), uAspect: U(1.6), uNear: U(1), uFar: U(2000),
      tScene: U(null), uCastGate: U(1.0),
    });

    this.mAOBlur = this._mat(AO_BLUR_FRAG, {
      tAO: U(null), tDepth: U(null), uDir: U(new THREE.Vector2()),
      uNear: U(1), uFar: U(2000),
      uDepthSigma: U(0.0045), uNormalPower: U(6.0),
    });

    this.mLit = this._mat(LIT_FRAG, {
      tScene: U(null), tAO: U(null), uAO: U(1.0), uAOTint: U(new THREE.Vector3(1, 1, 1)),
      uAOChroma: U(0.35), uVoxelCanyon: U(0), uVoxelKeep: U(0.0),
    });

    this.mBloomThresh = this._mat(BLOOM_THRESH_FRAG, {
      tSrc: U(null), uTexel: U(new THREE.Vector2()), uThreshold: U(0.85), uSoftness: U(0.6),
      uClamp: U(2.4),
    });
    this.mBloomDown = this._mat(BLOOM_DOWN_FRAG, { tSrc: U(null), uTexel: U(new THREE.Vector2()) });
    this.mBloomUp = this._mat(BLOOM_UP_FRAG,
      { tSrc: U(null), uTexel: U(new THREE.Vector2()), uRadius: U(0.85) },
      { blending: THREE.AdditiveBlending, transparent: true });

    this.mDofDown = this._mat(DOF_DOWN_FRAG, {
      tSrc: U(null), tDepth: U(null), uTexel: U(new THREE.Vector2()),
      uFocus: U(120), uRange: U(80), uNearRange: U(40), uStrength: U(1),
      uTilt: U(0.62), uTiltStart: U(0.24), uTiltEnd: U(0.88),
      uTiltCenter: U(0.5), uSkyGuard: U(1),
      uNear: U(1), uFar: U(2000),
    });
    this.mDofBokeh = this._mat(DOF_BOKEH_FRAG, {
      tDof: U(null), uTexel: U(new THREE.Vector2()), uRadiusPx: U(14), uTaps: U(32),
    });
    this.mDofFill = this._mat(DOF_FILL_FRAG, {
      tDof: U(null), uTexel: U(new THREE.Vector2()),
    });

    this.mComposite = this._mat(COMPOSITE_FRAG, {
      tLit: U(null), tBloom: U(null), tDof: U(null), tAO: U(null), tDepth: U(null),
      uBloom: U(0.55), uDof: U(1.0), uExposure: U(1.15), uSaturation: U(1.2),
      uContrast: U(1.1), uLift: U(0), uGamma: U(1), uGain: U(1), uVignette: U(0.34),
      uPunch: U(0.45), uWarm: U(0.075), uWB: U(new THREE.Vector3(1, 1, 1)), uTonemap: U(0), uKnee: U(0.9),
      uShadowLift: U(0), uShadowSat: U(0), uVibrance: U(0), uGreenLift: U(0),
      uShoulder: U(0.76), uBlackSlope: U(0), uBlackOffset: U(0.04), uCurve: U(new THREE.Vector3(1, 0.05, 0.3)), uCurveSat: U(0), uCurveGreen: U(0), uCurveDip: U(new THREE.Vector2(0, 0.3)), uCoolSat: U(new THREE.Vector2(0, 195)), uDeepDark: U(0), uAsphalt: U(new THREE.Vector2(0, 0.086)), uNightK: U(0), uFloor: U(new THREE.Vector4(0, 0.35, 2, 6.75)), uAtmo: U(new THREE.Vector3(0.1, 200, 900)),
      uAspect2: U(1.6), uDebug: U(0),
      uGround: U(new THREE.Vector4()), uAbove: U(new THREE.Vector4()), uGroundBand: U(new THREE.Vector4(0.45, 0.85, 0.3, 0.55)), uFloorGreen: U(0),
      uOrthoBox: U(new THREE.Vector4(-1, 1, -1, 1)), uWorldRowY: U(new THREE.Vector4(0, 1, 0, 0)),
      uEdge: U(0), uEdgeThr: U(0.4), uEdgeR: U(2), uDTexel: U(new THREE.Vector2(1, 1)),
      uMoonRim: U(new THREE.Vector4(0, 2, 0.4, 0)), uMoonRimCol: U(new THREE.Vector3(0.55, 0.66, 0.82)),
      uNear: U(1), uFar: U(2000),
    });

    this.mFXAA = this._mat(FXAA_FRAG, {
      tSrc: U(null), uRcp: U(new THREE.Vector2()), uSubpix: U(0.75),
      uEdgeThreshold: U(0.166), uEdgeThresholdMin: U(0.0833),
    });

    this.mCAS = this._mat(CAS_FRAG, {
      tSrc: U(null), uRcp: U(new THREE.Vector2()), uSharpen: U(0.3),
    });

    this.mResolve = this._mat(SS_RESOLVE_FRAG, {
      tSrc: U(null), uSrcSize: U(new THREE.Vector2(1, 1)), uDir: U(new THREE.Vector2(1, 0)),
      uScale: U(1), uB: U(1 / 3), uC: U(1 / 3),
    });

    this.mOutput = this._mat(OUTPUT_FRAG, {
      tSrc: U(null), tRaw: U(null), uRcp: U(new THREE.Vector2()),
      uSharpen: U(0.4), uSplit: U(0.0), uUsm: U(new THREE.Vector4()), uUsmCore: U(new THREE.Vector2(0.05, 0.14)),
      uToe: U(new THREE.Vector2(0, 0.14)),
      uDetail: U(new THREE.Vector4()), uDetailSim: U(new THREE.Vector4(0.07, 0.2, 0.2, 0.5)),
      tBlurF: U(null), tBlurM: U(null), uCrisp: U(new THREE.Vector4()), uCrispCore: U(new THREE.Vector2(0.006, 0.03)), uCrispClamp: U(new THREE.Vector2(0, 0)),
    });

    this.mLumaBlur = this._mat(LUMA_BLUR_FRAG, {
      tSrc: U(null), uStep: U(new THREE.Vector2()), uSigma: U(1), uLumaIn: U(1),
    });
  }

  // -------------------------------------------------------------------------
  // Render targets
  // -------------------------------------------------------------------------

  _rt(w, h, o = {}) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      minFilter: o.filter || THREE.LinearFilter,
      magFilter: o.filter || THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: o.type || THREE.UnsignedByteType,
      depthBuffer: !!o.depth,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: o.samples || 0,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    this._targets.push(rt);
    return rt;
  }

  _freeTargets() {
    for (let i = 0; i < this._targets.length; i++) {
      const rt = this._targets[i];
      if (rt.depthTexture) { rt.depthTexture.dispose(); rt.depthTexture = null; }
      rt.dispose();
    }
    this._targets.length = 0;
    this.rtScene = this.rtLit = this.rtAO0 = this.rtAO1 = null;
    this.rtDofA = this.rtDofB = this.rtLDR = this.rtAA = null;
    this.rtResH = this.rtResV = null;
    this.rtCrF0 = this.rtCrF1 = this.rtCrM0 = this.rtCrM1 = null;
    this.rtBloom = null;
  }

  /**
   * Internal render scale for supersampling. >1 only at a quality level that
   * allows it, and never so large the internal target exceeds aa.ssaaPixels
   * (a 2x retina canvas is already supersampled by the display itself).
   */
  _ssScale() {
    const A = this.params.aa || {};
    if (!this._q.ss || A.enabled === false || !(A.ssaa > 1)) return 1;
    const budget = A.ssaaPixels > 0 ? A.ssaaPixels : 2.3e6;
    let s = Math.min(A.ssaa, Math.sqrt(budget / Math.max(1, this._w * this._h)));
    s = Math.floor(s * 8) / 8;      // quantised (down): small resizes don't flip it
    return s < 1.2 ? 1 : s;         // under 1.2x a resolve pass is not worth it
  }

  _allocTargets() {
    const q = this._q;
    const ss = this._ssScale();
    this._ss = ss;
    const w = ss > 1 ? Math.round(this._w * ss) : this._w;
    const h = ss > 1 ? Math.round(this._h * ss) : this._h;
    this._iw = w; this._ih = h;

    let samples = Math.min(q.msaa, this._maxSamples);
    if (!this._hdrOK) samples = Math.min(samples, 0);
    this._samples = samples;

    // 1. HDR scene target + depth texture.
    this.rtScene = this._rt(w, h, { type: this._hdrType, depth: true, samples });
    const dt = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    dt.format = THREE.DepthFormat;
    dt.minFilter = THREE.NearestFilter;
    dt.magFilter = THREE.NearestFilter;
    this.rtScene.depthTexture = dt;

    // 2. AO ping-pong. Supersampled: AO is low-frequency by design, so it
    // runs at 0.75x internal (still >= output res) — full SS res would cost
    // ~3x the taps for a difference nobody can see after the resolve.
    const aoS = q.aoScale * (ss > 1 ? 0.75 : 1);
    const aw = Math.max(1, Math.round(w * aoS));
    const ah = Math.max(1, Math.round(h * aoS));
    this.rtAO0 = this._rt(aw, ah);
    this.rtAO1 = this._rt(aw, ah);
    this._aoW = aw; this._aoH = ah;

    // 3. AO-multiplied HDR.
    this.rtLit = this._rt(w, h, { type: this._hdrType });

    // 4. Bloom mip chain.
    this.rtBloom = [];
    let bw = Math.max(1, Math.round(w * q.bloomScale));
    let bh = Math.max(1, Math.round(h * q.bloomScale));
    for (let i = 0; i < q.bloomMips; i++) {
      this.rtBloom.push(this._rt(bw, bh, { type: this._hdrType }));
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }

    // 5. DOF (colour + CoC in alpha).
    const dw = Math.max(1, Math.round(w * q.dofScale));
    const dh = Math.max(1, Math.round(h * q.dofScale));
    this.rtDofA = this._rt(dw, dh, { type: this._hdrType });
    this.rtDofB = this._rt(dw, dh, { type: this._hdrType });
    this._dofW = dw; this._dofH = dh;

    // 6/7. LDR + AA.
    this.rtLDR = this._rt(w, h);
    this.rtAA = this._rt(w, h);

    // 8. Supersampling resolve: horizontal pass (outW x inH), vertical pass
    // (outW x outH). NEAREST so the resolve's texel-centre taps are exact.
    if (ss > 1) {
      this.rtResH = this._rt(this._w, h, { filter: THREE.NearestFilter });
      this.rtResV = this._rt(this._w, this._h);
    }

    // 9. r11 crisp: luma blur ping-pong at CSS resolution (fine band) and
    // half that (mid band). Half-float where available (8-bit luma would
    // quantise the band differences the coring works on).
    {
      const pr = Math.max(1, this._pr || 1);
      const cw = Math.max(1, Math.round(this._w / pr)), ch = Math.max(1, Math.round(this._h / pr));
      this.rtCrF0 = this._rt(cw, ch, { type: this._hdrType });
      this.rtCrF1 = this._rt(cw, ch, { type: this._hdrType });
      const mw = Math.max(1, Math.round(cw / 2)), mh = Math.max(1, Math.round(ch / 2));
      this.rtCrM0 = this._rt(mw, mh, { type: this._hdrType });
      this.rtCrM1 = this._rt(mw, mh, { type: this._hdrType });
      this._crW = cw; this._crH = ch; this._crMW = mw; this._crMH = mh;
    }

    this._allocCount = this._targets.length;
  }

  setSize(w, h, pixelRatio) {
    const pr = pixelRatio || this._pr || 1;
    const nw = Math.max(1, Math.round(w * pr));
    const nh = Math.max(1, Math.round(h * pr));
    if (nw === this._w && nh === this._h && this._targets.length) return;
    this._w = nw; this._h = nh; this._pr = pr;
    this._freeTargets();
    this._allocTargets();
  }

  setQuality(level) {
    const l = clamp(level | 0, 0, 2);
    if (l === this._quality && this._targets.length) return;
    const prevMsaa = this._q ? this._q.msaa : -1;
    const prevAoScale = this._q ? this._q.aoScale : -1;
    const prevMips = this._q ? this._q.bloomMips : -1;
    const prevSS = this._ss || 1;
    this._quality = l;
    this._q = QUALITY_TABLE[l];
    // Only reallocate when the target shapes actually change.
    if (this._q.msaa !== prevMsaa || this._q.aoScale !== prevAoScale ||
        this._q.bloomMips !== prevMips || this._ssScale() !== prevSS) {
      this._freeTargets();
      this._allocTargets();
    }
  }

  getQuality() { return this._quality; }

  // wave-2: the scene's key / sky / ambient lights, for the twilight white
  // balance (grade.wb). Optional — without them the balance stays identity.
  setLights(sun, hemi, ambient) { this._lights = { sun, hemi, ambient }; }

  // Twilight white balance gains into `out` (Vector3). See grade.wb.
  _updateWB(out, W, ctx) {
    out.set(1, 1, 1);
    const L = this._lights;
    if (!W || !L || !L.sun || !(W.amount > 0)) return;
    const ill = (dst) => {
      const s = L.sun, h = L.hemi, a = L.ambient, sw = W.sunWeight ?? 0.35;
      dst[0] = s.color.r * s.intensity * sw; dst[1] = s.color.g * s.intensity * sw; dst[2] = s.color.b * s.intensity * sw;
      if (h) { dst[0] += h.color.r * h.intensity; dst[1] += h.color.g * h.intensity; dst[2] += h.color.b * h.intensity; }
      if (a) { dst[0] += a.color.r * a.intensity; dst[1] += a.color.g * a.intensity; dst[2] += a.color.b * a.intensity; }
      const y = 0.2126 * dst[0] + 0.7152 * dst[1] + 0.0722 * dst[2];
      if (!(y > 1e-5)) return false;
      dst[0] /= y; dst[1] /= y; dst[2] /= y;
      return true;
    };
    const ne = (ctx && typeof ctx.nightEff === 'number') ? ctx.nightEff : 0;
    const cur = this._wbCur || (this._wbCur = [1, 1, 1]);
    if (!ill(cur)) return;
    // Day reference: the live daytime illuminant chroma (a slow EMA so a
    // weather flicker cannot jolt it). Default = the authored noon rig
    // (key #fffaf2 x3.3 x0.35 + hemi #e4ecf6 x1.48), for games loaded at dusk.
    const ref = this._wbRef || (this._wbRef = [0.985, 1.0, 1.02]);
    if (ne < 0.05) for (let i = 0; i < 3; i++) ref[i] += (cur[i] - ref[i]) * 0.05;
    const S = THREE.MathUtils.smoothstep;
    const k = clamp(W.amount, 0, 1) * S(ne, W.lo0 ?? 0.2, W.lo1 ?? 0.36) * (1 - S(ne, W.hi0 ?? 0.5, W.hi1 ?? 0.66));
    if (k <= 1e-4) return;
    const mg = Math.max(1, W.maxGain ?? 2);
    const g = [0, 0, 0];
    for (let i = 0; i < 3; i++) g[i] = clamp(Math.pow(ref[i] / Math.max(cur[i], 1e-4), k), 1 / mg, mg);
    // Normalise so a white surface under the CURRENT illuminant keeps its
    // luminance (cur is luma-normalised): only the cast changes, not exposure.
    const gy = 0.2126 * g[0] * cur[0] + 0.7152 * g[1] * cur[1] + 0.0722 * g[2] * cur[2];
    out.set(g[0] / gy, g[1] / gy, g[2] / gy);
  }

  setParams(p) {
    if (!p) return;
    // Recursive partial merge: nested groups (grade.curve) merge too, so
    // setParams({grade:{curve:{gamma:1.2}}}) keeps the curve's other keys.
    // Arrays and non-plain values are assigned (copied), never aliased into
    // the caller's object.
    const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
    const merge = (dst, src) => {
      for (const k in src) {
        const v = src[k];
        if (v === undefined) continue;
        if (isObj(v)) {
          if (!isObj(dst[k])) dst[k] = {};
          merge(dst[k], v);
        } else {
          dst[k] = Array.isArray(v) ? v.slice() : v;
        }
      }
    };
    merge(this.params, p);
    // Explicit focus/range disable the auto-derived values.
    if (p.dof && p.dof.focus !== undefined && p.dof.autoFocus === undefined) {
      this.params.dof.autoFocus = !(p.dof.focus > 0);
    }
    // Supersampling knobs change the target shapes.
    if (p.aa && this._targets && this._targets.length && this._ssScale() !== (this._ss || 1)) {
      this._freeTargets();
      this._allocTargets();
    }
  }

  getParams() { return this.params; }

  /**
   * Bokeh radius, in HALF-RES pixels, for a circle of confusion of 1.0.
   * Exposed so the harness can assert the mapping instead of guessing at it.
   */
  _dofRadiusPx() {
    return Math.max(1.5, (this.params.dof.maxBlur || 0) * this._dofH * 0.025);
  }

  // -------------------------------------------------------------------------
  // Passes
  // -------------------------------------------------------------------------

  _blit(material, target, clear) {
    this._fsMesh.material = material;
    this.renderer.setRenderTarget(target || null);
    if (clear) this.renderer.clear(true, false, false);
    this.renderer.render(this._fsScene, this._fsCam);
  }

  render(dt, ctx) {
    const r = this.renderer;
    if (!this.rtScene) this.setSize(this._w, this._h, this._pr);

    const camera = (ctx && ctx.camera) || this.camera;
    if (ctx && typeof ctx.quality === 'number' && ctx.quality !== this._quality) {
      this.setQuality(ctx.quality);
    }
    const q = this._q;
    const P = this.params;

    const near = camera.near, far = camera.far;
    // OrthographicCamera (the true-iso game camera): linear depth, parallel
    // rays. tanHalf carries the view half-height in world units and aspect
    // the half-width/half-height ratio — the VIEWPOS shader branch reads them so.
    const ortho = !!camera.isOrthographicCamera;
    const oz = camera.zoom || 1;
    const tanHalf = ortho ? (camera.top - camera.bottom) * 0.5 / oz
      : Math.tan(THREE.MathUtils.degToRad(camera.fov || 40) * 0.5);
    const aspect = ortho ? (camera.right - camera.left) / Math.max(1e-6, camera.top - camera.bottom)
      : (camera.aspect || (this._w / this._h));
    const orthoU = ortho ? 1 : 0;
    for (let i = 0; i < this._materials.length; i++) {
      const uo = this._materials[i].uniforms.uOrthoCam;
      if (uo) uo.value = orthoU;
    }

    // ---- Save renderer state -------------------------------------------
    const oldTarget = r.getRenderTarget();
    const oldAutoClear = r.autoClear;
    const oldTone = r.toneMapping;
    const oldExposure = r.toneMappingExposure;
    r.toneMapping = THREE.NoToneMapping;
    r.toneMappingExposure = 1;

    // ---- 1. scene -> HDR ------------------------------------------------
    r.autoClear = true;
    r.setRenderTarget(this.rtScene);
    r.clear(true, true, true);
    if (this.scene) r.render(this.scene, camera);
    r.autoClear = false;

    const depthTex = this.rtScene.depthTexture;

    // w4r2 city-scale depth factor (params.depth): 0 at close zoom, 1 from
    // depth.distHi out. Read by the SSAO / LIT passes and the shade floor.
    const Dp = P.depth || {};
    const dk = Dp.enabled === false ? 0
      : THREE.MathUtils.smoothstep((ctx && ctx.camDist) || 205, Dp.distLo ?? 50, Math.max((Dp.distLo ?? 50) + 1, Dp.distHi ?? 85));
    const dLerp = (a, b) => (b == null ? a : a + (b - a) * dk);

    // ---- 2. SSAO ---------------------------------------------------------
    const S = P.ssao;
    const aoOn = q.ao && S.enabled !== false && (S.intensity > 0 || S.contactIntensity > 0);
    if (aoOn) {
      const u = this.mSSAO.uniforms;
      u.tDepth.value = depthTex;
      u.tScene.value = this.rtScene.texture;              // alpha = ssaoKeep (occluder gate)
      u.uCastGate.value = S.castGate === undefined ? 1.0 : S.castGate;
      u.uTexel.value.set(1 / this._iw, 1 / this._ih);
      u.uAOSize.value.set(this._aoW, this._aoH);
      u.uSamples.value = q.aoSamples;
      u.uRadius.value = S.radius;
      u.uContactRadius.value = S.contactRadius;
      u.uCanyonRadius.value = S.canyonRadius || 6.0;
      u.uCanyonIntensity.value = dLerp(S.canyonIntensity || 0, Dp.canyonIntensity);
      u.uBias.value = S.bias;
      u.uIntensity.value = S.intensity;
      u.uContactIntensity.value = S.contactIntensity;
      u.uPower.value = S.power;
      u.uContactPower.value = S.contactPower;
      u.uMinPixels.value = S.minPixels;
      u.uMaxPixels.value = S.maxPixels;
      u.uPlaneBias.value = S.planeBias === undefined ? 0.05 : S.planeBias;
      u.uTanHalfFov.value = tanHalf;
      u.uAspect.value = aspect;
      u.uNear.value = near;
      u.uFar.value = far;
      this._blit(this.mSSAO, this.rtAO0);

      // Stride is ALWAYS one AO texel: the [1,2,2,2,1]/8 kernel spans exactly
      // one period of the 4x4 rotation tile only at stride 1. Anything coarser
      // (the old code used 2 at full res) leaves the two column parities
      // completely unmixed, i.e. a per-pixel checkerboard.
      const stride = S.denoiseStride > 0 ? S.denoiseStride : 1;
      const b = this.mAOBlur.uniforms;
      b.tDepth.value = depthTex;
      b.uNear.value = near;
      b.uFar.value = far;
      b.uDepthSigma.value = S.denoiseDepthSigma > 0 ? S.denoiseDepthSigma : 0.0045;
      b.uNormalPower.value = S.denoiseNormalPower >= 0 ? S.denoiseNormalPower : 6.0;
      b.tAO.value = this.rtAO0.texture;
      b.uDir.value.set(stride / this._aoW, 0);
      this._blit(this.mAOBlur, this.rtAO1);
      b.tAO.value = this.rtAO1.texture;
      b.uDir.value.set(0, stride / this._aoH);
      this._blit(this.mAOBlur, this.rtAO0);
    }

    // ---- 3. lit = scene * AO --------------------------------------------
    {
      const u = this.mLit.uniforms;
      u.tScene.value = this.rtScene.texture;
      u.tAO.value = aoOn ? this.rtAO0.texture : null;
      u.uAO.value = aoOn ? 1.0 : 0.0;
      const t = P.ssao.tint;
      u.uAOTint.value.set(t[0], t[1], t[2]);
      u.uAOChroma.value = P.ssao.chroma > 0 ? P.ssao.chroma : 0;
      u.uVoxelKeep.value = clamp(dLerp(P.ssao.voxelKeep || 0, Dp.voxelKeep), 0, 1);
      u.uVoxelCanyon.value = clamp(dLerp(P.ssao.voxelCanyon || 0, Dp.voxelCanyon), 0, 1);
      this._blit(this.mLit, this.rtLit);
    }

    // ---- 4. bloom --------------------------------------------------------
    // Night-only by default: strength ramps in with ctx.nightEff and the whole
    // chain is skipped while it is zero.
    let bloomK = 1;
    if (P.bloom.nightOnly !== false) {
      const ne = (ctx && typeof ctx.nightEff === 'number') ? ctx.nightEff : 0;
      bloomK = THREE.MathUtils.smoothstep(ne, P.bloom.nightStart ?? 0.18, P.bloom.nightFull ?? 0.6);
    }
    const bloomStrength = P.bloom.strength * bloomK;
    const bloomOn = P.bloom.enabled !== false && bloomStrength > 0.002;
    if (bloomOn) {
      const t = this.mBloomThresh.uniforms;
      t.tSrc.value = this.rtLit.texture;
      t.uTexel.value.set(1 / this._iw, 1 / this._ih);
      t.uThreshold.value = P.bloom.threshold;
      t.uSoftness.value = P.bloom.softness;
      t.uClamp.value = P.bloom.clamp > 0 ? P.bloom.clamp : 1e6;
      this._blit(this.mBloomThresh, this.rtBloom[0]);

      const d = this.mBloomDown.uniforms;
      for (let i = 1; i < this.rtBloom.length; i++) {
        const src = this.rtBloom[i - 1];
        d.tSrc.value = src.texture;
        d.uTexel.value.set(1 / src.width, 1 / src.height);
        this._blit(this.mBloomDown, this.rtBloom[i]);
      }
      const up = this.mBloomUp.uniforms;
      up.uRadius.value = P.bloom.radius;
      for (let i = this.rtBloom.length - 1; i > 0; i--) {
        const src = this.rtBloom[i];
        up.tSrc.value = src.texture;
        up.uTexel.value.set(1 / src.width, 1 / src.height);
        this._blit(this.mBloomUp, this.rtBloom[i - 1]);   // additive, no clear
      }
    }

    // ---- 5. tilt-shift DOF ----------------------------------------------
    const dofOn = q.dof && P.dof.enabled !== false && P.dof.strength > 0;
    let focus = 0;
    if (dofOn) {
      const camDist = (ctx && ctx.camDist) || 205;
      focus = P.dof.autoFocus ? camDist : (P.dof.focus > 0 ? P.dof.focus : camDist);
      const range = P.dof.range > 0 ? P.dof.range : Math.max(10, camDist * P.dof.rangeScale);
      // Miniature read: strongest at close orbit, subtle when zoomed way out.
      const mini = THREE.MathUtils.lerp(1.0, 0.45, THREE.MathUtils.smoothstep(camDist, 60, 320));

      const u = this.mDofDown.uniforms;
      u.tSrc.value = this.rtLit.texture;
      u.tDepth.value = depthTex;
      u.uTexel.value.set(1 / this._iw, 1 / this._ih);
      u.uFocus.value = focus;
      u.uRange.value = range;
      u.uNearRange.value = Math.max(4, range * (P.dof.nearRatio > 0 ? P.dof.nearRatio : 1));
      u.uStrength.value = P.dof.strength * mini;
      u.uTilt.value = P.dof.tilt * mini;
      u.uTiltStart.value = P.dof.tiltStart;
      u.uTiltEnd.value = P.dof.tiltEnd === undefined ? 0.86 : P.dof.tiltEnd;
      u.uTiltCenter.value = clamp(P.dof.tiltCenter === undefined ? 0.5 : P.dof.tiltCenter, 0.05, 0.95);
      // Kept as a knob purely so the sky-blur regression can be A/B'd from the
      // harness. Ship it at 1; there is no art-direction reason to blur infinity.
      u.uSkyGuard.value = P.dof.skyGuard === false ? 0 : 1;
      u.uNear.value = near;
      u.uFar.value = far;
      this._blit(this.mDofDown, this.rtDofA);

      const b = this.mDofBokeh.uniforms;
      b.tDof.value = this.rtDofA.texture;
      b.uTexel.value.set(1 / this._dofW, 1 / this._dofH);
      // CoC 1.0 maps to maxBlur * 2.5% of the half-res buffer height. Anchoring
      // to the buffer instead of a fixed 16 px at some assumed resolution keeps
      // the miniature read identical from 720p to 1440p, and makes the number
      // checkable: at maxBlur 0.95 and a 720-row half-res buffer this is 17.1
      // half-res px at CoC 1, i.e. 8.6 at CoC 0.5 — a real, countable bokeh
      // circle rather than a sub-texel one.
      b.uRadiusPx.value = this._dofRadiusPx();
      b.uTaps.value = q.dofTaps;
      this._blit(this.mDofBokeh, this.rtDofB);

      const f = this.mDofFill.uniforms;
      f.tDof.value = this.rtDofB.texture;
      f.uTexel.value.set(1 / this._dofW, 1 / this._dofH);
      this._blit(this.mDofFill, this.rtDofA);   // ping-pong: A is free again here
    }

    // ---- 6. composite (tonemap + grade + vignette) ----------------------
    {
      const u = this.mComposite.uniforms;
      const G = P.grade;
      u.tLit.value = this.rtLit.texture;
      u.tBloom.value = bloomOn ? this.rtBloom[0].texture : null;
      u.tDof.value = dofOn ? this.rtDofA.texture : null;   // after the fill pass
      u.tAO.value = aoOn ? this.rtAO0.texture : null;
      u.tDepth.value = depthTex;
      u.uBloom.value = bloomOn ? bloomStrength : 0;
      u.uDof.value = dofOn ? 1.0 : 0.0;
      u.uExposure.value = G.exposure;
      u.uSaturation.value = G.saturation;
      u.uContrast.value = G.contrast;
      u.uLift.value = G.lift;
      u.uGamma.value = G.gamma;
      u.uGain.value = G.gain;
      u.uVignette.value = G.vignette;
      u.uPunch.value = G.punch;
      u.uWarm.value = G.warm;
      this._updateWB(u.uWB.value, G.wb, ctx);
      u.uTonemap.value = G.tonemap === 'aces' ? 1 : 0;
      u.uKnee.value = G.knee > 0 ? G.knee : 0.9;
      u.uShadowLift.value = G.shadowLift || 0;
      u.uShadowSat.value = G.shadowSat || 0;
      u.uVibrance.value = G.vibrance || 0;
      u.uGreenLift.value = G.greenLift || 0;
      u.uShoulder.value = clamp(G.shoulder != null ? G.shoulder : 0.76, 0.3, 0.98);
      u.uBlackSlope.value = clamp(G.blackSlope || 0, 0, 0.9);
      u.uBlackOffset.value = clamp(G.blackOffset != null ? G.blackOffset : 0.04, 0, 0.06);
      const Cv = G.curve || {};
      u.uCurve.value.set(Cv.gamma != null ? Cv.gamma : 1, Cv.toe0 != null ? Cv.toe0 : 0.05, Cv.toe1 != null ? Cv.toe1 : 0.3);
      u.uCurveSat.value = Cv.sat || 0;
      u.uCurveGreen.value = Cv.green || 0;
      u.uCurveDip.value.set(clamp(Cv.dip || 0, 0, 0.18), clamp(Cv.dipStart != null ? Cv.dipStart : 0.3, 0, 0.9));
      u.uCoolSat.value.set(G.coolSat || 0, G.coolHue != null ? G.coolHue : 195);
      u.uDeepDark.value = clamp(G.deepDark || 0, 0, 0.5);
      const As = G.asphalt || {};
      u.uAsphalt.value.set(clamp(As.amount || 0, 0, 0.9), As.target != null ? As.target : 0.086);
      // night r1: the asphalt ops are DAYLIGHT road grading. At night a faint
      // warm lamp pool on near-black asphalt sits exactly on their chroma and
      // luma gates, so per-pixel road noise flipped pixels in and out of the
      // "pull neutral darks up to 0.08" band: a grey/orange sparkle ring round
      // every lamp. Fade them (and the black-plateau chroma switch) out at night.
      {
        const neK = (ctx && typeof ctx.nightEff === 'number') ? ctx.nightEff : 0;
        u.uNightK.value = THREE.MathUtils.smoothstep(neK, 0.35, 0.7);
        this._nightEffK = u.uNightK.value;
      }
      // r9 overview factor: 1 while a building voxel (0.25 u) is under
      // overview.lo CSS px (the default 'iso' overview), 0 from overview.hi up
      // (iso-mid and every closer zoom keep the round-8 look unchanged).
      const voxPx = ortho ? 0.25 * this._h / Math.max(1e-6, 2 * tanHalf) : 99;
      this._voxelPx = voxPx;
      const Ov = P.overview || {};
      const voxCss = voxPx / Math.max(1, this._pr || 1);
      const ov = (Ov.enabled === false || P.debug !== 'none') ? 0
        : 1 - THREE.MathUtils.smoothstep(voxCss, Ov.lo ?? 2.4, Math.max((Ov.lo ?? 2.4) + 0.01, Ov.hi ?? 3.4));
      this._overview = ov;
      {
        const F = G.floor || {};
        const n0 = clamp(F.shape != null ? F.shape : 2, 1, 8);
        const n = THREE.MathUtils.lerp(n0, clamp(Ov.floorShape ?? n0, 1, 8), ov);
        const nu0 = clamp(F.neutral != null ? F.neutral : 0.35, 0, 1);
        const nu = THREE.MathUtils.lerp(nu0, clamp(Ov.floorNeutral ?? nu0, 0, 1), ov);
        const ym = 1 / (n + 1);
        const fAmt = clamp(F.amount || 0, 0, 0.4) * (1 - ov * (1 - clamp(Ov.floor ?? 1, 0, 1)))
          * dLerp(1, clamp(Dp.floor ?? 1, 0, 1));
        u.uFloorGreen.value = clamp(F.green != null ? F.green : (F.amount || 0), 0, 0.4);
        u.uFloor.value.set(fAmt, nu, n, 1 / (ym * Math.pow(1 - ym, n)));
      }
      const A = P.atmo || { strength: 0, start: 0.35, rangeScale: 3.5 };
      const camD = (ctx && ctx.camDist) || 205;
      u.uAtmo.value.set(A.strength, camD * A.start, camD * A.rangeScale);
      u.uAspect2.value = aspect;
      // Silhouette ink threshold: at least `edge.minStep` world units, and never
      // under ~2 internal pixels' worth of world size (a far zoom must not ink
      // every voxel step on a facade).
      const E = P.edge || {};
      const wpp = ortho ? (2 * tanHalf) / Math.max(1, this._ih) : 0.05;
      {
        const Gk = Ov.ground || {};
        const gAmt = (ortho && ov > 0) ? clamp(Gk.amount || 0, 0, 0.4) * ov : 0;
        const Ab = G.above || {};
        u.uAbove.value.set(ortho && Ab.enabled !== false && (P.debug === 'none' || P.debug === 'height') ? clamp(Ab.amount ?? 1, 0, 1) : 0,
          Ab.lo ?? 0.7, Math.max((Ab.lo ?? 0.7) + 0.01, Ab.hi ?? 1.0), 0);
        u.uGround.value.set(gAmt, Gk.y0 ?? 1.15, Math.max((Gk.y0 ?? 1.15) + 0.01, Gk.y1 ?? 1.7), clamp(Gk.white ?? 1, 0, 0.99));
        u.uGroundBand.value.set(Gk.lo ?? 0.45, Math.max((Gk.lo ?? 0.45) + 0.01, Gk.hi ?? 0.85),
          Gk.satLo ?? 0.3, Math.max((Gk.satLo ?? 0.3) + 0.01, Gk.satHi ?? 0.55));
        if (ortho) {
          u.uOrthoBox.value.set(camera.left / oz, camera.right / oz, camera.bottom / oz, camera.top / oz);
          const m = camera.matrixWorld.elements;
          u.uWorldRowY.value.set(m[1], m[5], m[9], m[13]);
        }
      }
      u.uEdge.value = (E.enabled === false || P.debug !== 'none') ? 0
        : THREE.MathUtils.lerp(E.strength || 0, Ov.inkStrength ?? (E.strength || 0), ov);
      const inkSlope = THREE.MathUtils.lerp(E.slope > 0 ? E.slope : 4, Ov.inkSlope ?? (E.slope > 0 ? E.slope : 4), ov);
      // Line width is set in CSS px so it reads the same on a retina canvas and
      // a supersampled 1x one; the step threshold also rises with the ring
      // radius in world units (convex corners give a residual of ~R px).
      const inkR = Math.max(1, (E.width > 0 ? E.width : 1.3) * (this._pr || 1) * (this._ss || 1));
      u.uEdgeR.value = inkR;
      u.uEdgeThr.value = Math.max(E.minStep > 0 ? E.minStep : 0.35,
        wpp * Math.max(E.minPixels > 0 ? E.minPixels : 2, inkR * inkSlope));
      u.uDTexel.value.set(1 / this._iw, 1 / this._ih);
      // night w4r4: moonlit silhouette rim (see the grade shader). Width in CSS
      // px like the ink; the depth step never under ~2 internal px of world.
      {
        const MR = P.moonRim || {};
        const on = MR.enabled !== false && P.debug === 'none';
        const k = on ? (this._nightEffK || 0) * clamp(MR.strength || 0, 0, 1) : 0;
        const R = Math.max(1, (MR.width > 0 ? MR.width : 1.2) * (this._pr || 1) * (this._ss || 1));
        u.uMoonRim.value.set(k, R, Math.max(MR.minStep > 0 ? MR.minStep : 0.35, wpp * Math.max(2, R * (MR.slope > 0 ? MR.slope : 3))), 0);
        const col = MR.color || [0.55, 0.66, 0.82];
        u.uMoonRimCol.value.set(col[0], col[1], col[2]);
      }
      u.uNear.value = near;
      u.uFar.value = far;
      u.uDebug.value = DEBUG_ID[P.debug] || 0;
      this._blit(this.mComposite, this.rtLDR);
    }

    // ---- 7. sharpen + AA -------------------------------------------------
    // CAS runs BEFORE the AA resolve. Sharpening after FXAA re-hardens the very
    // steps FXAA just resolved and doubles the frame's 1-pixel-period energy;
    // sharpening first lets FXAA arbitrate the result. `sharpen.beforeAA=false`
    // puts CAS back in the final pass for A/B.
    // Supersampled frames skip both FXAA (the resolve already integrates ~9+
    // coverage samples per pixel; FXAA on top only smears texture detail) and
    // CAS (the Mitchell resolve is the sharpness decision).
    const ssOn = this._ss > 1;
    // r11: a retina canvas with >= aa.fxaaMsaa MSAA samples skips FXAA (see
    // params.aa.fxaaMsaa): its sub-pixel blend only softened 1-px detail.
    const fxMs = P.aa.fxaaMsaa ?? 4;
    const retinaMsaa = fxMs > 0 && this._samples >= fxMs && (this._pr || 1) >= 1.5;
    const aaOn = !ssOn && !retinaMsaa && q.aa && P.aa.enabled !== false && P.debug === 'none';
    const sharpenOn = !ssOn && q.sharpen && P.sharpen.enabled !== false && P.debug === 'none'
      && P.sharpen.amount > 0;
    const casFirst = sharpenOn && P.sharpen.beforeAA !== false && aaOn;

    let final = this.rtLDR;
    if (casFirst) {
      const u = this.mCAS.uniforms;
      u.tSrc.value = final.texture;
      u.uRcp.value.set(1 / this._iw, 1 / this._ih);
      u.uSharpen.value = P.sharpen.amount;
      this._blit(this.mCAS, this.rtAA);
      final = this.rtAA;
    }
    if (aaOn) {
      // Ping-pong between the two LDR targets so no third full-res target is
      // needed when CAS runs first.
      const dst = (final === this.rtAA) ? this.rtLDR : this.rtAA;
      const u = this.mFXAA.uniforms;
      u.tSrc.value = final.texture;
      u.uRcp.value.set(1 / this._iw, 1 / this._ih);
      u.uSubpix.value = P.aa.subpix;
      u.uEdgeThreshold.value = P.aa.edgeThreshold;
      u.uEdgeThresholdMin.value = P.aa.edgeThresholdMin;
      this._blit(this.mFXAA, dst);
      final = dst;
    }

    // ---- 7b. supersampling resolve (internal -> output) ------------------
    if (ssOn) {
      const u = this.mResolve.uniforms;
      u.uB.value = P.aa.filterB ?? (1 / 3);
      u.uC.value = P.aa.filterC ?? (1 / 3);
      u.tSrc.value = final.texture;
      u.uSrcSize.value.set(this._iw, this._ih);
      u.uDir.value.set(1, 0);
      u.uScale.value = this._iw / this._w;
      this._blit(this.mResolve, this.rtResH);
      u.tSrc.value = this.rtResH.texture;
      u.uSrcSize.value.set(this._w, this._ih);
      u.uDir.value.set(0, 1);
      u.uScale.value = this._ih / this._h;
      this._blit(this.mResolve, this.rtResV);
      final = this.rtResV;
    }

    // ---- 7c. r11 crisp: luma blurs of the final (post-AA) frame ------------
    const Cr = P.crisp || {};
    let crispK = 0;
    if (Cr.enabled !== false && P.debug === 'none' && q.sharpen && this.rtCrF0 && ((Cr.fine || 0) > 0 || (Cr.mid || 0) > 0)) {
      // Close-zoom scale: 1 while a building voxel is under closeLo CSS px,
      // `close` from closeHi up.
      const voxCss = (this._voxelPx || 99) / Math.max(1, this._pr || 1);
      const cz = THREE.MathUtils.smoothstep(voxCss, Cr.closeLo ?? 5, Math.max((Cr.closeLo ?? 5) + 0.01, Cr.closeHi ?? 12));
      crispK = THREE.MathUtils.lerp(1, clamp(Cr.close ?? 1, 0, 2), cz);
      // r12 distance gate (coordinator 22:05 rule; critic r11: "crunchy edge
      // sharpening and dark outline halos on umbrellas, storefronts and cars
      // in iso-close"): ZERO below distLo (iso-close / one-* zooms, iso-mid
      // barely), full from distHi (overview). Exactly 0 -> the blur blits are
      // skipped as well.
      if (Cr.distHi > 0) {
        const cd = (ctx && ctx.camDist) || 205;
        crispK *= THREE.MathUtils.smoothstep(cd, Cr.distLo ?? 70, Math.max((Cr.distLo ?? 70) + 1, Cr.distHi));
      }
    }
    if (crispK <= 0.001) crispK = 0;
    if (crispK > 0) {
      const b = this.mLumaBlur.uniforms;
      const sf = Math.max(0.3, Cr.sigmaFine || 1);
      // Fine band at CSS res, sigma in CSS px (= taps).
      b.tSrc.value = final.texture; b.uLumaIn.value = 1; b.uSigma.value = sf;
      b.uStep.value.set(1 / this._crW, 0);
      this._blit(this.mLumaBlur, this.rtCrF1);
      b.tSrc.value = this.rtCrF1.texture; b.uLumaIn.value = 0;
      b.uStep.value.set(0, 1 / this._crH);
      this._blit(this.mLumaBlur, this.rtCrF0);
      // Mid band at half CSS res from the fine result. Taps 1.5 CSS px apart
      // (the fine blur already removed what that spacing could alias).
      const sm = Math.max(sf + 0.5, Cr.sigmaMid || 4);
      b.tSrc.value = this.rtCrF0.texture; b.uSigma.value = sm / 1.5;
      b.uStep.value.set(1.5 / this._crW, 0);
      this._blit(this.mLumaBlur, this.rtCrM1);
      b.tSrc.value = this.rtCrM1.texture;
      b.uStep.value.set(0, 1.5 / this._crH);
      this._blit(this.mLumaBlur, this.rtCrM0);
    }

    // ---- 8. output: trailing CAS (only if not already applied) + A/B split
    {
      const u = this.mOutput.uniforms;
      u.tBlurF.value = crispK > 0 ? this.rtCrF0.texture : null;
      u.tBlurM.value = crispK > 0 ? this.rtCrM0.texture : null;
      u.uCrisp.value.set(crispK * (Cr.fine || 0), crispK * (Cr.mid || 0), Cr.limitFine ?? 0.1, Cr.limitMid ?? 0.06);
      u.uCrispCore.value.set(Cr.coreLo ?? 0.006, Math.max((Cr.coreLo ?? 0.006) + 1e-4, Cr.coreHi ?? 0.03));
      u.uCrispClamp.value.set(crispK > 0 && (Cr.overshoot ?? -1) >= 0 ? Math.max(1, (Cr.clampStep || 1) * (this._pr || 1)) : 0, Math.max(0, Cr.overshoot ?? 0));
      u.tSrc.value = final.texture;
      u.tRaw.value = this.rtScene.texture;
      u.uRcp.value.set(1 / this._w, 1 / this._h);
      u.uSharpen.value = (sharpenOn && !casFirst) ? P.sharpen.amount : 0;
      u.uSplit.value = P.split;
      const Us = P.usm || {};
      // Without supersampling the frame already went through CAS + FXAA, and
      // quality 1's cheaper shadow/AO taps carry more grain: sharpen gently.
      const usmK = (q.sharpen && Us.enabled !== false && P.debug === 'none')
        ? (ssOn ? 1 : (Us.noSS != null ? Us.noSS : 0.4)) : 0;
      // Round 6: the fine (1-px) band fades out as a building voxel (0.25 u)
      // shrinks below ~4.5 device px — at overview zoom it only turned 1-voxel
      // detail into speckle/shimmer (critic r5). The ring band (block-scale
      // value separation) is kept at every zoom.
      const voxPx = this._voxelPx;
      const fz = Us.farLo > 0 ? THREE.MathUtils.smoothstep(voxPx, Us.farLo, Math.max(Us.farLo + 0.01, Us.farHi || 4.5)) : 1;
      u.uUsm.value.set(usmK * (Us.fine || 0) * fz, usmK * (Us.edge || 0),
        Math.max(1, Us.radius || 2.5), Math.max(0, Us.overshoot || 0));
      const c0 = Us.coreLo != null ? Us.coreLo : 0.05;
      u.uUsmCore.value.set(c0, Math.max(c0 + 1e-3, Us.coreHi != null ? Us.coreHi : 0.14));
      // r9: overview-only acutance (critic r8: "soft at the default overview
      // zoom; ref05 has crisp edges; the close shot is already sharp"). The
      // global USM stays off (coordinator 16:50 veto on close-zoom ringing);
      // this one exists only while ov > 0, i.e. never at iso-mid or closer.
      // Ring radius is in CSS px so a retina frame and a 1x frame get the same
      // edge width after the display (or the critic's) downscale.
      const OvS = (P.overview && P.overview.sharpen) || {};
      if (usmK === 0 && crispK === 0 && this._overview > 0 && P.debug === 'none' && OvS.enabled !== false) {
        const ovk = this._overview;
        u.uUsm.value.set(ovk * (OvS.fine || 0), ovk * (OvS.edge || 0),
          Math.max(1, (OvS.radius || 1.25) * (this._pr || 1)), Math.max(0, OvS.overshoot ?? 0.1));
        const o0 = OvS.coreLo ?? 0.04;
        u.uUsmCore.value.set(o0, Math.max(o0 + 1e-3, OvS.coreHi ?? 0.12));
      }
      const Dt = P.detail || {};
      // Zoom gate: full strength while a building voxel is under zoomLo device
      // px (overview), zero from zoomHi up — iso-mid/close frames and every
      // close-up are bit-identical to detail OFF.
      const dz = 1 - THREE.MathUtils.smoothstep(voxPx, Dt.zoomLo ?? 4, Math.max((Dt.zoomLo ?? 4) + 0.01, Dt.zoomHi ?? 8));
      const dOn = Dt.enabled !== false && P.debug === 'none' && dz > 0.001;
      u.uDetail.value.set(dOn ? clamp(Dt.chroma || 0, 0, 1) * dz : 0, dOn ? clamp(Dt.luma || 0, 0, 1) * dz : 0,
        Math.max(1, (Dt.radius || 3) * (this._pr || 1)), 0);
      u.uDetailSim.value.set(Dt.simLo ?? 0.07, Math.max((Dt.simLo ?? 0.07) + 1e-3, Dt.simHi ?? 0.2),
        Dt.lo ?? 0.2, Math.max((Dt.lo ?? 0.2) + 1e-3, Dt.hi ?? 0.5));
      const T = P.grade.toe || {};
      u.uToe.value.set(P.debug === 'none' ? Math.max(0, T.amount || 0) : 0, Math.max(0.02, T.end || 0.14));
      this._blit(this.mOutput, null);
    }

    // ---- restore ---------------------------------------------------------
    r.setRenderTarget(oldTarget);
    r.autoClear = oldAutoClear;
    r.toneMapping = oldTone;
    r.toneMappingExposure = oldExposure;
  }

  dispose() {
    this._freeTargets();
    for (let i = 0; i < this._materials.length; i++) this._materials[i].dispose();
    this._materials.length = 0;
    this._fsGeo.dispose();
    this._fsScene.remove(this._fsMesh);
  }
}

const DEBUG_ID = { none: 0, ao: 1, bloom: 2, coc: 3, depth: 4, normals: 5, raw: 0, edge: 6, height: 7 };

// ---------------------------------------------------------------------------
// selfTest — CONTRACTS-RENDER.md §4
// ---------------------------------------------------------------------------

function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : ((s ? -1 : 1) * Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

/**
 * Headless-ish assertions. Pass a renderer to reuse the game's context;
 * otherwise a throwaway 64x64 context is created.
 * @returns {{pass:boolean, notes:string[]}}
 */
export function selfTest(renderer) {
  const notes = [];
  let pass = true;
  const fail = (m) => { pass = false; notes.push('FAIL: ' + m); };
  const ok = (m) => notes.push('ok: ' + m);

  let ownRenderer = false;
  let r = renderer;
  try {
    if (!r) {
      if (typeof document === 'undefined') {
        return { pass: false, notes: ['FAIL: no document and no renderer supplied'] };
      }
      const c = document.createElement('canvas');
      c.width = 128; c.height = 128;
      r = new THREE.WebGLRenderer({ canvas: c, antialias: false });
      ownRenderer = true;
    }
  } catch (e) {
    return { pass: false, notes: ['FAIL: could not create a WebGLRenderer: ' + e.message] };
  }

  // A tiny stand-in scene with the shapes the AO/DOF passes care about.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87d4f5);
  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 1, 2000);
  cam.position.set(28, 22, 28);
  cam.lookAt(0, 3, 0);
  const geo = new THREE.BoxGeometry(4, 8, 4);
  const mat = new THREE.MeshLambertMaterial({ color: 0xff8844 });
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set((i % 3) * 8 - 8, 4 + (i % 2) * 3, Math.floor(i / 3) * 8 - 4);
    scene.add(m);
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200),
    new THREE.MeshLambertMaterial({ color: 0x86d94f }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x6b8f4e, 0.8));
  const dl = new THREE.DirectionalLight(0xfff4e0, 1.2);
  dl.position.set(40, 60, 20);
  scene.add(dl);

  let fx = null;
  const errors = [];
  const realError = console.error;
  const realWarn = console.warn;
  try {
    fx = new PostFX(r, scene, cam, { width: 256, height: 144, pixelRatio: 1, quality: 2 });
    ok('constructed (hdr=' + (fx._hdrOK ? 'half-float' : 'byte') + ', msaa=' + fx._samples + 'x)');

    // --- shaders compile ----------------------------------------------
    console.error = (...a) => { errors.push(a.join(' ')); };
    console.warn = (...a) => { const s = a.join(' '); if (/shader|program|glsl/i.test(s)) errors.push(s); };
    r.debug.checkShaderErrors = true;
    for (let q = 0; q <= 2; q++) {
      fx.setQuality(q);
      fx.render(0.016, { camera: cam, camDist: 120, quality: q });
    }
    console.error = realError;
    console.warn = realWarn;
    if (errors.length) fail('shader compile/link errors: ' + errors.slice(0, 3).join(' | '));
    else ok('all pass shaders compiled and linked at quality 0/1/2');

    fx.setQuality(2);
    fx.render(0.016, { camera: cam, camDist: 120, quality: 2 });

    // --- no NaN/Inf in the HDR chain ----------------------------------
    if (fx._hdrType === THREE.HalfFloatType) {
      const buf = new Uint16Array(fx.rtLit.width * fx.rtLit.height * 4);
      try {
        r.readRenderTargetPixels(fx.rtLit, 0, 0, fx.rtLit.width, fx.rtLit.height, buf);
        let bad = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = halfToFloat(buf[i]);
          if (!Number.isFinite(v)) bad++;
        }
        if (bad) fail(bad + ' non-finite half-float texels in the lit HDR target');
        else ok('HDR lit target: ' + (buf.length / 4) + ' texels, all finite');
      } catch (e) {
        notes.push('skip: half-float readback unsupported (' + e.message + ')');
      }
    }

    // --- LDR output is sane -------------------------------------------
    {
      const w = fx.rtLDR.width, h = fx.rtLDR.height;
      const px = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(fx.rtLDR, 0, 0, w, h, px);
      let sum = 0, mn = 255, mx = 0;
      for (let i = 0; i < px.length; i += 4) {
        const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
        sum += l; if (l < mn) mn = l; if (l > mx) mx = l;
      }
      const avg = sum / (px.length / 4);
      if (!Number.isFinite(avg)) fail('LDR readback produced NaN');
      else if (mx - mn < 4) fail('LDR output is flat (min ' + mn + ', max ' + mx + ') — pipeline likely broken');
      else if (avg < 12) fail('LDR output is nearly black (avg ' + avg.toFixed(1) + ')');
      else ok('LDR output avg ' + avg.toFixed(1) + ', range ' + mn + '..' + mx);
    }

    // --- AO actually darkens something --------------------------------
    {
      const w = fx.rtAO0.width, h = fx.rtAO0.height;
      const px = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(fx.rtAO0, 0, 0, w, h, px);
      let mn = 255, occluded = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < mn) mn = px[i];
        if (px[i] < 230) occluded++;
      }
      const frac = occluded / (px.length / 4);
      if (mn > 250) fail('SSAO produced no occlusion anywhere (min ' + mn + ')');
      else ok('SSAO min ' + mn + ', ' + (frac * 100).toFixed(1) + '% of pixels occluded');
    }

    // --- the grade may never clip one channel while its siblings live --
    // Run the most hostile grade the art direction could ask for. A pixel with
    // exactly one channel at 0 and another above 8/255 is a hue clip, not a
    // black pixel, and is the "toxic green shadow" failure.
    {
      const keep = JSON.parse(JSON.stringify(fx.getParams().grade));
      fx.setParams({ grade: { punch: 1.0, saturation: 1.6, contrast: 1.5, lift: 0, exposure: 1.65 } });
      fx.render(0.016, { camera: cam, camDist: 120, quality: 2 });
      const w = fx.rtLDR.width, h = fx.rtLDR.height;
      const px = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(fx.rtLDR, 0, 0, w, h, px);
      let hue = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) {
        n++;
        const mx = Math.max(px[i], px[i + 1], px[i + 2]);
        const mn = Math.min(px[i], px[i + 1], px[i + 2]);
        if (mn === 0 && mx >= 8) hue++;
      }
      fx.setParams({ grade: keep });
      const pct = 100 * hue / n;
      if (pct > 1.0) fail('grade clips a single channel to 0 on ' + pct.toFixed(2) + '% of the frame');
      else ok('grade is channel-safe under punch 1.0 / sat 1.6 / contrast 1.5 (' + pct.toFixed(3) + '% hue clip)');
    }

    // --- the DOF gather must actually move pixels ----------------------
    // "The blur runs and nothing changes" is the failure this guards: a CoC to
    // pixel-radius mapping that resolves sub-pixel, or a tap weight that
    // discards the disc, both leave a zero A/B delta with the pass enabled.
    {
      // At a realistic output size: the radius is a fraction of the buffer, so
      // a 256x144 probe would legitimately resolve sub-pixel and prove nothing.
      fx.setSize(1280, 720, 1);
      fx.setParams({ dof: { enabled: true } });
      fx.render(0.016, { camera: cam, camDist: 120, quality: 2 });
      const w = fx.rtLDR.width, h = fx.rtLDR.height;
      const a = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(fx.rtLDR, 0, 0, w, h, a);
      fx.setParams({ dof: { enabled: false } });
      fx.render(0.016, { camera: cam, camDist: 120, quality: 2 });
      const b = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(fx.rtLDR, 0, 0, w, h, b);
      fx.setParams({ dof: { enabled: true } });
      // Outer sixth of the frame top and bottom: outside any sane focal band.
      let sum = 0, n = 0;
      const band = Math.max(1, Math.floor(h / 6));
      for (let y = 0; y < h; y++) {
        if (y >= band && y < h - band) continue;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          sum += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
          n++;
        }
      }
      const mean = sum / Math.max(1, n);
      const radPx = fx._dofRadiusPx();
      if (radPx * 0.5 < 3) fail('DOF radius at CoC 0.5 is ' + (radPx * 0.5).toFixed(2) + ' half-res px at 720p — too small to move a pixel');
      else if (mean < 0.5) fail('DOF changes nothing outside the focal band (mean delta ' + mean.toFixed(3) + '/255)');
      else ok('DOF: ' + radPx.toFixed(1) + ' half-res px at CoC 1, outer-band delta ' + mean.toFixed(2) + '/255');
    }

    // --- 100 resize cycles, no target leak ----------------------------
    {
      const texBefore = r.info.memory.textures;
      const countBefore = fx._targets.length;
      for (let i = 0; i < 100; i++) {
        const w = 160 + ((i * 37) % 480);
        const h = 90 + ((i * 53) % 270);
        fx.setSize(w, h, 1);
      }
      fx.render(0.016, { camera: cam, camDist: 120, quality: 2 });
      const texAfter = r.info.memory.textures;
      const countAfter = fx._targets.length;
      if (countAfter !== countBefore) {
        fail('render-target count drifted over 100 resizes: ' + countBefore + ' -> ' + countAfter);
      } else if (texAfter - texBefore > 2) {
        fail('GPU texture count grew by ' + (texAfter - texBefore) + ' over 100 resizes (leak)');
      } else {
        ok('100 resize cycles: ' + countAfter + ' targets, texture delta ' + (texAfter - texBefore));
      }
    }

    // --- params round-trip --------------------------------------------
    {
      const radiusBefore = fx.getParams().ssao.radius;
      fx.setParams({ ssao: { intensity: 0.5 }, grade: { exposure: 1.4 }, aa: { enabled: false } });
      const p = fx.getParams();
      if (p.ssao.intensity !== 0.5 || p.grade.exposure !== 1.4 ||
          p.ssao.radius !== radiusBefore || p.aa.enabled !== false) {
        fail('setParams partial merge is wrong');
      } else ok('setParams merges partially without clobbering siblings');
    }

    // --- dispose is clean ---------------------------------------------
    {
      const before = r.info.memory.textures;
      fx.dispose();
      fx = null;
      const after = r.info.memory.textures;
      if (after > before) fail('dispose() increased texture count');
      else ok('dispose() released ' + (before - after) + ' textures');
    }
  } catch (e) {
    console.error = realError;
    console.warn = realWarn;
    fail('threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e));
  } finally {
    console.error = realError;
    console.warn = realWarn;
    try { if (fx) fx.dispose(); } catch (e) { /* ignore */ }
    geo.dispose(); mat.dispose();
    ground.geometry.dispose(); ground.material.dispose();
    if (ownRenderer) { try { r.dispose(); r.forceContextLoss(); } catch (e) { /* ignore */ } }
  }

  return { pass, notes };
}
