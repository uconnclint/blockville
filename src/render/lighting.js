// src/render/lighting.js — the AAA lighting + shadow rig for Blockville.
//
// Owns: sun/moon celestial rig, hemisphere + IBL ambient, cascaded shadow maps
// (CSM) with PCSS-style contact-hardening soft shadows, and a batched night
// "light pool" system for street lamps / window spill.
//
// See CONTRACTS-RENDER.md §3.8. Three.js r160, vendored. No addons, no build.
//
// ---------------------------------------------------------------------------
// WHY THE OLD SHADOWS WERE INVISIBLE (root cause, confirmed in
// tools/rendertest/lighting.html with the "legacy" toggle):
//
//   engine.js set `sun.shadow.normalBias = 0.9`. In three.js that value is in
//   WORLD UNITS: `shadowmap_vertex` does
//       shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * shadowNormalBias, 0 )
//   so every receiving fragment's shadow lookup was displaced 0.9 world units
//   along its own normal — nearly a full voxel. On the ground (normal +Y) that
//   is a 0.78-unit push toward the light plus a 0.45-unit LATERAL slide of the
//   whole shadow pattern. Stacked on `shadow.bias = -0.0006`, which over the
//   1613-unit ortho depth span is another ~0.97 world units of pull-back, the
//   receiver was sampled ~1.75 units off the caster. Anything shorter than
//   ~2 voxels lost its shadow entirely and everything else was detached
//   (peter-panning) and offset.
//
//   Compounding it: ONE ortho frustum of ±480 world units at 3072², i.e.
//   0.3125 world units per texel — coarser than a voxel — so what survived the
//   bias was smeared to mush by the PCF_SOFT filter's texel-sized kernel and
//   read as flat dirt rather than shadow.
//
//   The fix is not a different constant. Bias must be expressed in TEXELS of
//   the cascade doing the lookup: this rig sets normal offset = 1.6 texels and
//   depth bias = 0.7 texels, both scaled per cascade and slope-scaled by the
//   receiver's N·L, so cascade 0 (≈0.09 world units/texel) biases by ~0.15
//   units and the far cascade biases by ~1 unit — always sub-texel, never
//   detached.
//
// ---------------------------------------------------------------------------
// AND WHY THE *NEW* SHADOWS STILL DID NOT READ IN THE SHIPPING GAME
// (three separate defects, all measured in index.html, not guessed):
//
//   1. THE SKY IBL BYPASSED THE SHADOW ENTIRELY. The contract's two splices
//      only reach `directLight.color` and `irradiance`. The sky PMREM lands in
//      `iblIrradiance`, which is accumulated later, in <lights_fragment_maps>.
//      Turning each light source off one at a time at noon gave, as a share of
//      the rendered frame's luminance: sun ~10 %, hemi+ambient ~13 %, sky IBL
//      ~44 %. A shadow that could only remove the first two took roughly a
//      tenth of the light off the ground and was, correctly, invisible.
//      -> csmLightsFragmentMaps() adds the third splice; csmIblScale() /
//         csmSpecularScale() occlude the environment as well.
//
//   2. THE CASCADE CAMERAS WERE ORIENTED FROM A STALE POSITION. They are
//      created with matrixAutoUpdate = false (deliberately — we compose their
//      matrices by hand), and Object3D.lookAt() begins with
//      updateWorldMatrix(), which under that flag does NOT recompose `matrix`
//      from `position`. lookAt therefore aimed the camera from wherever it was
//      LAST frame. In the running game that is a one-frame lag and merely
//      smears shadows while the camera moves; on the first update after
//      construction the position reads as the origin and the entire cascade is
//      aimed somewhere else, which is why an offscreen fixture rendered zero
//      shadow while the game rendered an approximately-right one.
//      -> the orientation now comes straight from `_rot`, the same basis the
//         texel snapping uses.
//
//   3. PCSS + SECOND-DEPTH CASTERS OVER-ESTIMATED EVERY PENUMBRA. With
//      casterSide = BackSide the atlas stores where the ray LEAVES the caster,
//      so the blocker distance is inflated by the caster's thickness; a
//      30-voxel tower reported a ~60-unit gap and pinned the penumbra at
//      maxPenumbra, turning shadows into grey clouds.
//      -> softness/maxPenumbra tightened; see the option block.
//
//   Residual: engine.js overwrites the rig's sun/hemi/ambient from sky.js AFTER
//   update(), at roughly sun 0.64, hemi 0.73, ambient 0.16, envMapIntensity
//   0.55-0.60, so the direct key is a minority of the light in that mix. That is
//   no longer un-reachable from here — see ROUND FIVE below, where the fill's
//   COLOUR is re-graded through accessors that survive the overwrite — but the
//   LEVELS are still engine.js's call. See §3.8.4 `exposure` / `fillBoost` if
//   that ratio is ever handed back to this module.
//
// ---------------------------------------------------------------------------
// AND THEN THE OVER-CORRECTION (round three — all three measured on the device
// framebuffer with gl.readPixels; tools/rendertest/shadowmeter.js reproduces
// every number below):
//
//   1. SHADOWED GROUND CRUSHED TO BLACK. Fixing (1) above by occluding the
//      indirect terms with the CAST-SHADOW term is a category error: being
//      sun-blocked says nothing about how much SKY a point sees. Open road
//      lying in a tower's long shadow still sees the whole dome; it was being
//      shaded as if it were at the bottom of a street canyon.
//      -> indirect/IBL occlusion is now driven by csmSkyOcclusion(), a sky
//         VISIBILITY estimate built from the PCSS blocker distance (contact
//         proximity), and only reaches its maximum where a blocker is actually
//         adjacent. Measured lit:shadow sRGB medians on the reference city:
//         road 7.95 -> 3.88, terrain 6.14 -> 3.95 (street shot), against a
//         3-4:1 target.
//
//   2. PENUMBRA STIPPLE ("blue confetti" along every rooftop shadow edge).
//      16 PCSS taps with a per-pixel interleaved-gradient kernel rotation make
//      every pixel an independent Bernoulli estimate — white noise, all of it
//      at the 1-pixel period, and there is no shadow denoise pass downstream to
//      remove it. Two changes: the rotation is quantised to a 4x4 screen block
//      (uCsmTaps.z is now a block SIZE, not a flag), and every tap does the
//      bilinear blend a hardware sampler2DShadow would do (csmTap), which is
//      what removes the 16-step stair a NearestFilter packed-depth atlas
//      otherwise produces. Rooftop penumbra hf1: 3.513 -> 1.047 against an
//      un-shadowed baseline of 0.31. Tap budget halved to pay for it.
//
//   3. THE LOW-SUN FADE STARTED FAR TOO EARLY. smoothstep(1 deg, 9 deg) auto-
//      faded a 6.4-degree sun to strength 0.731 — golden hour is exactly when
//      shadows should be longest and most dramatic.
//      -> shadowFadeLo/Hi (0.4 deg / 3.0 deg) and minShadowElevation 4.5 -> 2.0.
//
// ---------------------------------------------------------------------------
// ROUND FOUR: THE STIPPLE FIX ONLY HELD AT THE DISTANCE IT WAS TUNED AT.
//
//   The kernel-rotation + bilinear-tap work above was measured at one framing,
//   and it fixed that framing. It could not fix the others, because every
//   filter width in this file was specified in WORLD units — minPenumbra 0.08,
//   the 0.55-texel radius floor — while the thing being sampled is a SCREEN.
//   0.08 world units is ~4 device pixels of penumbra at the street shot, ~1.5
//   at hero and ~0.6 at region: as the camera pulls back the shadow edge slides
//   under the framebuffer's Nyquist limit and gets point-sampled, which is
//   aliasing by construction. Rooftop hf1 excess over a shadows-OFF clean plate
//   on the same pixels ran 0.29 / 1.02 / 0.42 (street / hero / region) at
//   2880x1800, and 0.28 / 0.95 / 0.19 at 1200x600 — same shader, same
//   parameters, an answer per zoom level.
//
//   The fix is to make the filter footprint resolution-aware instead of
//   world-aware. csmApply computes the world size of one DEVICE pixel on the
//   shaded surface (view Z x 2tan(fov/2)/drawingBufferHeight, over |N.V| for
//   foreshortening) and csmSampleCascade floors the PCF radius at
//   `penumbraFloorPixels` of them, widens the blocker search to match so the
//   early-out cannot cut a hard edge through the widened penumbra, and adds
//   taps (`tapDensity`) to whatever the floor widened so the bigger disk is
//   actually filtered rather than sparsely poked. Every one of those is scale
//   free, so the edge now holds the same width in PIXELS at any zoom and any
//   device pixel ratio.
//
//   Result (SM.report rooftopPenumbraHf1.excess, A/B inside one page load
//   because the demo city is only deterministic per load), off -> on:
//
//     buffer      hero           region         street         golden
//     2880x1800   0.973 -> 0.683 0.403 -> 0.318 0.288 -> 0.276 0.140 -> 0.141
//     1200x600    0.489 -> 0.287 0.137 -> 0.163 0.218 -> 0.217 0.132 -> 0.123
//
//   street and golden barely move because the near camera IS the distance the
//   old world-space constants were tuned for — that is the whole point. The
//   region rooftop figure at 1200x600 rides on ~140 surviving roof pixels and
//   is worth +-0.04 of nothing; the same shot's smooth-penumbra probe over
//   1.6k building pixels reads 0.216 -> 0.189. lit:shadow ratios move by under
//   0.05 and the sub-luma-4 fraction not at all, so §3.8's verified contrast
//   work is untouched. Frame time is unchanged: at 2880x1800 the frame is
//   nowhere near shadow-tap bound (forcing all 16 taps everywhere measured
//   4.50 ms against 4.46 ms for 8; hero medians 4.24 ms both ways).
//
//   What was tried and rejected: widening each bilinear tap's own tent to cover
//   the gap between taps (same four fetches, coarser lattice). It quantises the
//   tap to a coarse grid, which puts a kink in the shadow term every few texels
//   — and hf1 is a discrete Laplacian, so it scores kinks exactly like noise.
//   Measured 0.63 -> 0.77 at hero. See csmTap().
//
// ---------------------------------------------------------------------------
// ROUND FIVE: THE COLOUR OF THE LIGHT, AND WHICH BODY IS CASTING IT.
//
//   1. "GOLDEN HOUR" WAS MEASURABLY BLUE. At the `golden` shot the key is a
//      2.83:1 warm sun (#ffb95a, 19.94 deg) — and the LIT road/terrain/building
//      measured R/B 0.69 / 0.65 / 0.61, i.e. 40 % bluer than neutral. The fill
//      was the reason: hemisphere #48b3ff @ 0.434 and ambient #4799de @ 0.112
//      sat at DAYLIGHT BLUE all the way to the horizon, and the diffuse sky IBL
//      (the single biggest contributor to a ground pixel — measured 27 % of the
//      red but 41 % of the blue on lit road) was blue with them. Skylight is not
//      a constant: when the sun is low the zenith stops being fed and the dome a
//      horizontal surface integrates is the warm horizon band.
//      -> _skylightWarmAmount() ramps over sun elevation 34 -> 18 deg and
//         re-grades hemisphere, ambient AND the diffuse IBL toward
//         `skylightHorizon`, at close to constant LUMINANCE so the measured
//         lit:shadow ratios do not move. Lit R/B at golden: 0.69/0.65/0.61 ->
//         1.34/1.06/1.16, ratios 1.74/1.83 -> 1.77/1.87, hero (63 deg)
//         bit-identical. `skylightWarmth: 0` restores the old behaviour.
//
//      NOTE the delivery mechanism (_installSkylightGrade): engine.js copies
//      sky.js's analytic fill onto these lights every frame AFTER update()
//      returns, so a plain assignment here is dead on arrival — which is how the
//      fill came to be daylight blue in the first place. The re-grade is
//      therefore installed as accessors: writers own the BASE, this rig owns the
//      elevation grade of it, and no one has to be reordered.
//
//   2. THE MOON KEY SHAPED NOTHING. Two bugs, one cause — in 'external' mode
//      sky.js hands over `keyDir`, which IS the moon at night, so `sunDir.y < 0`
//      reported isMoon FALSE at nightT 0.92 (it was still being graded as a
//      sunrise), and the moon it handed over sits at a fixed 4.3 deg, which
//      delivers sin(4.3) = 0.075 of itself to a road or a roof. Measured
//      lit:shadow on night road: 0.65 — the "lit" side was DARKER than the
//      shadowed side, because the key was contributing nothing to shape it.
//      -> isMoon now comes from the clock (`moonAfterLo/Hi`), and
//         `moonKeyElevation` floors the moon key onto a real arc, light and
//         cascades together. Night road lit:shadow 0.65 -> 1.19, horizontal
//         direct receipt 0.022 -> 0.148. The visible DISC is sky.js's: the
//         proper fix is for sky.js to raise its own moon arc, at which point the
//         floor stops firing by itself. See _updateCelestial.
// ---------------------------------------------------------------------------

import * as THREE from '../../vendor/three.module.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const CSM_MAX_CASCADES = 4;

// ---------------------------------------------------------------------------
// Shader: the CSM lookup a material must splice in.
// ---------------------------------------------------------------------------

/**
 * Declarations + the `csmApply()` function. Dependency-free (it carries its own
 * copies of unpackRGBAToDepth / inverseTransformDirection) so it can be
 * prepended verbatim to any fragment shader.
 */
export const CSM_FRAGMENT_PARS = /* glsl */`
#define CSM_MAX_CASCADES 4
#define CSM_MAX_TAPS 16
#define CSM_MAX_SEARCH 12

uniform sampler2D uCsmAtlas;
uniform vec2  uCsmAtlasTexel;
uniform float uCsmCount;
uniform vec4  uCsmTaps;                        // x pcf taps, y search taps, z rotate 0/1, w indirect occlusion
uniform vec4  uCsmSplits[ CSM_MAX_CASCADES ];  // x,y fade-in band | z,w fade-out band (view Z)
uniform mat4  uCsmMatrix[ CSM_MAX_CASCADES ];  // world -> cascade [0,1]^3
uniform vec4  uCsmParams[ CSM_MAX_CASCADES ];  // x texelWorld, y depthRange, z normalOffset, w depthBias
uniform vec4  uCsmRect[ CSM_MAX_CASCADES ];    // xy atlas offset, zw atlas scale
uniform vec4  uCsmSoft;                        // x minPenumbra, y searchWorld, z softness, w maxPenumbra
uniform vec4  uCsmMisc;                        // x strength, y debug, z fadeStart, w fadeEnd
uniform vec4  uCsmFill;                        // x iblOcclusion, y specOcclusion, z shadowContrast, w worldPerPixelPerViewZ
uniform vec4  uCsmSky;                         // x contactWorld, y openSkyFloor, z bilinearTaps 0/1, w penumbraFloorPixels
uniform vec4  uCsmTune;                        // x tapDensity (taps per texel^2 of disk), yzw reserved
uniform vec3  uCsmOrigin;                      // world origin the varying is relative to
uniform vec3  uCsmIblTint;                     // low-sun skylight tint for the DIFFUSE sky IBL; (1,1,1) = off
uniform vec4  uCsmWallFill;                    // x away-wall fill cut, y key-wall fill gain, z day amount (0 = off), w share of the cut applied to sky SPECULAR
uniform vec4  uCsmShadowTint;                  // rgb hue of the sky fill inside a cast shadow on up-facing ground (lum ~1), a = amount (0 = off)
uniform vec3  uCsmWallTint;                    // hue of the away-wall fill (linear, luminance ~1)
uniform vec3  uCsmKeyDirW;                     // WORLD direction scene -> key (sun by day)

// NOTE: vCsmWorldPos is CAMERA-RELATIVE (world minus uCsmOrigin) and uCsmMatrix
// already folds that translation in. Blockville's world spans 0..640; feeding
// absolute coordinates through an interpolator costs ~0.3 world units of
// precision on some drivers, which is several shadow texels of acne.
varying highp vec3  vCsmWorldPos;
varying highp float vCsmViewZ;

// 24-bit RGB depth unpack. Must mirror CASTER_FRAG in lighting.js exactly.
// (We do NOT use three's packDepthToRGBA: measured on WebKit/WebGL2 its
// vHighPrecisionZW varying round-trips at ~9 bits, which shows up as ~0.4
// world units of depth error and unavoidable acne. gl_FragCoord.z + this
// packing round-trips to <1e-6.)
float csmUnpackDepth( const in vec4 v ) {
	return dot( v.rgb, vec3( 1.0, 1.0 / 256.0, 1.0 / 65536.0 ) );
}

vec3 csmInvXformDir( const in vec3 dir, const in mat4 m ) {
	return normalize( ( vec4( dir, 0.0 ) * m ).xyz );
}

// Interleaved gradient noise -> a stable per-pixel rotation for the sample disk.
float csmDither( const in vec2 p ) {
	return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

// Vogel (sunflower) disk: evenly distributed for ANY tap count, so the tap
// budget can be a uniform and quality switches never recompile a shader.
vec2 csmVogel( const in float i, const in float n, const in float phi ) {
	float r = sqrt( ( i + 0.5 ) / n );
	float th = i * 2.39996323 + phi;
	return vec2( cos( th ), sin( th ) ) * r;
}

// One shadow tap.
//
// The atlas is NearestFilter (it has to be: the depth is RGB-packed, so the
// hardware may not blend it), which makes a plain tap a STAIRCASE in uv — each
// of the 16 taps flips wholesale as the lookup crosses a texel boundary, so
// neighbouring pixels differ by 1/16 of the full shadow contrast. On a rooftop
// penumbra that alone measured hf1 ~1.8 with the kernel rotation already
// switched off. Doing the bilinear blend on the COMPARISON RESULT (which is
// what a hardware sampler2DShadow does) makes each tap continuous in uv, so the
// penumbra becomes a real gradient instead of a 16-step stair. Costs 4 fetches
// per tap, so the tap budget is halved when it is on — 8 continuous taps beat
// 16 binary ones on every metric that matters here.
//
// The tent is ONE TEXEL wide and must stay that way. Widening it to cover the
// gap between taps of a large disk was tried (same four fetches, coarser
// lattice) and measured WORSE: snapping the tent's control points to a coarse
// grid puts a kink in the shadow term every few texels, and hf1 is a
// discrete Laplacian, so it scores kinks exactly like noise. Rooftop hf1 excess
// went 0.63 -> 0.77 at hero with the wide tent in. Extra coverage has to come
// from extra taps (see nPcf below), not from stretching the reconstruction.
float csmTap( const in vec2 uv, const in float recvZ, const in vec2 uvMin, const in vec2 uvMax ) {
	if ( uCsmSky.z < 0.5 ) {
		return csmUnpackDepth( texture2D( uCsmAtlas, clamp( uv, uvMin, uvMax ) ) ) < recvZ ? 0.0 : 1.0;
	}
	vec2 tx = uCsmAtlasTexel;
	vec2 g = uv / tx - 0.5;
	vec2 f = fract( g );
	vec2 b = ( floor( g ) + 0.5 ) * tx;
	float s00 = csmUnpackDepth( texture2D( uCsmAtlas, clamp( b, uvMin, uvMax ) ) ) < recvZ ? 0.0 : 1.0;
	float s10 = csmUnpackDepth( texture2D( uCsmAtlas, clamp( b + vec2( tx.x, 0.0 ), uvMin, uvMax ) ) ) < recvZ ? 0.0 : 1.0;
	float s01 = csmUnpackDepth( texture2D( uCsmAtlas, clamp( b + vec2( 0.0, tx.y ), uvMin, uvMax ) ) ) < recvZ ? 0.0 : 1.0;
	float s11 = csmUnpackDepth( texture2D( uCsmAtlas, clamp( b + tx, uvMin, uvMax ) ) ) < recvZ ? 0.0 : 1.0;
	return mix( mix( s00, s10, f.x ), mix( s01, s11, f.x ), f.y );
}

float csmCascadeWeight( const in float vz, const in vec4 s ) {
	float a = ( s.y > s.x ) ? clamp( ( vz - s.x ) / ( s.y - s.x ), 0.0, 1.0 ) : 1.0;
	float b = ( s.w > s.z ) ? clamp( ( s.w - vz ) / ( s.w - s.z ), 0.0, 1.0 ) : 1.0;
	return a * b;
}

// ---- debug read-outs ------------------------------------------------------
// Filled by csmSampleCascade for the LAST cascade it actually sampled, so the
// debug views below can show what the lookup really did per fragment. Costs
// nothing when uCsmMisc.y == 0 (the compiler drops them: they only feed the
// debug branch, which is a uniform branch).
vec2  csmDbgUV    = vec2( 0.0 );   // atlas UV actually sampled
float csmDbgAtlas = 1.0;           // depth read out of the atlas
float csmDbgRecv  = 0.0;           // this fragment's own depth in light space
float csmDbgIdx   = -1.0;          // cascade index used
float csmDbgIn    = 0.0;           // 1 if the fragment projected inside the cascade

// Contact proximity, written by csmSampleCascade alongside its return value.
// 1 = the blocker is right here (street canyon, wall base, under an eave),
// 0 = the blocker is far away (open ground lying in a long cast shadow).
//
// It is derived from the PCSS blocker gap, which is trustworthy for exactly
// this purpose *because* the atlas stores second depth (casterSide = BackSide):
// a light ray that passes through a closed voxel shell exits at the shell's far
// surface, and for a building standing on the ground that far surface is its
// FOOTPRINT. So the gap is, to first order, the distance from the receiver back
// to the caster's footprint along the light — small in the canyon, large out at
// the tip of a long shadow. That is precisely the discrimination the sky term
// needs, and it costs nothing extra: the blocker search already computed it.
float csmProxOut = 0.0;

// Iso layout coverage of the cascade just sampled: 1 well inside the tight
// cascade-0 rectangle, fading to 0 over its outer 3 % (see csmApply).
float csmCoverOut = 0.0;

// ---- grid tent filter (iso layout, round 4) --------------------------------
// The r3 critic: rooftop shadows were "smeared, streaky, dithered grey
// blotches with ragged edges". Two causes, both fixed here and in the iso fit:
// (1) a shadow texel was 4-9 device pixels; (2) a 16-tap Vogel disk over a
// 5-texel radius is a SUM OF 16 SHIFTED STEP EDGES, which is exactly a streaky
// ghosted edge (and a rotated disk turns it into dither). This is the exact
// alternative: every texel in a (2K+2)^2 window is compared once and weighted
// by a separable tent of radius r texels centred on the lookup, which is a
// continuous function of both the lookup position and r — a clean, even ramp
// with no noise, no ghosts and no swim. r follows the PCSS blocker gap
// (contact-hardening: ~1 texel at a wall foot, K texels for long shadows).
// The blocker search reads a stride-2 lattice over the same window, so it
// cannot early-out through the penumbra it is about to filter, and fully lit /
// fully shadowed fragments stop after (K+1)^2 fetches.
// Screen-space derivatives of the (camera-relative) world position, taken at
// the top of csmApply before any non-uniform branch. They give the receiver
// PLANE in shadow space, so each texel of the filter window is compared
// against the receiver's own depth at THAT texel instead of at the window
// centre. Without it a lit wall just under a convex ledge compares its window
// against the ledge top one texel away and grows a comb of false shadow teeth
// along every roof edge (r4, measured on the bakery parapet).
vec3 csmDPdx = vec3( 0.0 );
vec3 csmDPdy = vec3( 0.0 );

float csmGridFilter( const in int ci, const in vec2 uv, const in float recvZ0, const in vec2 uvMin, const in vec2 uvMax, const in float texelWorld, const in float depthRange ) {
	// Receiver plane: depth change per atlas texel along x / y.
	mat3 lin = mat3( uCsmMatrix[ ci ] );
	vec3 ddx = lin * csmDPdx;
	vec3 ddy = lin * csmDPdy;
	float det = ddx.x * ddy.y - ddx.y * ddy.x;
	vec2 dz = vec2( 0.0 );
	if ( abs( det ) > 1e-14 ) dz = vec2( ddx.z * ddy.y - ddy.z * ddx.y, ddx.x * ddy.z - ddy.x * ddx.z ) / det;
	vec2 dzT = dz * ( uCsmAtlasTexel / uCsmRect[ ci ].zw );
	float dzMax = 2.5 * texelWorld / depthRange;             // slope cap (~68 deg)
	dzT = clamp( dzT, - dzMax, dzMax );
	// The plane term replaces most of the slope-scaled bias for the window;
	// keep the constant part as the floor against quantisation.
	float recvZ = recvZ0;
	int K = int( uCsmTune.z + 0.5 );
	int N = 2 * K + 2;
	vec2 tx = uCsmAtlasTexel;
	vec2 g = uv / tx - 0.5;
	vec2 base = floor( g );
	vec2 f = g - base;
	float sum = 0.0;
	float hits = 0.0;
	float cnt = 0.0;
	for ( int j = 0; j < 4; j ++ ) {
		if ( j > K ) break;
		for ( int i = 0; i < 4; i ++ ) {
			if ( i > K ) break;
			vec2 o = vec2( float( 2 * i - K ), float( 2 * j - K ) );
			float d = csmUnpackDepth( texture2D( uCsmAtlas, clamp( ( base + o + 0.5 ) * tx, uvMin, uvMax ) ) );
			float rz = recvZ + dot( dzT, o - f );
			cnt += 1.0;
			if ( d < rz ) { sum += rz - d; hits += 1.0; }
		}
	}
	if ( hits < 0.5 ) return 1.0;
	float gap = max( 0.0, ( sum / hits ) * depthRange );
	csmProxOut = exp2( - gap / max( uCsmSky.x, 0.01 ) );
	if ( hits > cnt - 0.5 ) return 0.0;
	float pen = clamp( gap * uCsmSoft.z, uCsmSoft.x, uCsmSoft.w );
	float r = clamp( pen / texelWorld, 1.0, float( K ) );
#if __VERSION__ >= 300
	// PERF: visit only the taps whose tent weight can be non-zero
	// (|o - f| < r, bounds widened by a texel and re-tested), instead of an
	// 8x8 grid of mostly-skipped iterations. Same taps, same weights, same
	// summation order as the fixed-bound loops below (the skipped terms were
	// exact zeros), so the result is bit-identical; it matters because every
	// SIMD group that holds one penumbra fragment ran all 64 iterations.
	int i0 = max( 0, int( floor( float( K ) + f.x - r ) ) ), i1 = min( N - 1, int( ceil( float( K ) + f.x + r ) ) );
	int j0 = max( 0, int( floor( float( K ) + f.y - r ) ) ), j1 = min( N - 1, int( ceil( float( K ) + f.y + r ) ) );
	float sx = 0.0;
	float sy = 0.0;
	for ( int i = i0; i <= i1; i ++ ) sx += max( 0.0, 1.0 - abs( float( i - K ) - f.x ) / r );
	for ( int j = j0; j <= j1; j ++ ) sy += max( 0.0, 1.0 - abs( float( j - K ) - f.y ) / r );
	float lit = 0.0;
	for ( int j = j0; j <= j1; j ++ ) {
		float wyj = max( 0.0, 1.0 - abs( float( j - K ) - f.y ) / r );
		if ( wyj <= 0.0 ) continue;
		float row = 0.0;
		for ( int i = i0; i <= i1; i ++ ) {
			float wxi = max( 0.0, 1.0 - abs( float( i - K ) - f.x ) / r );
			if ( wxi <= 0.0 ) continue;
			vec2 o = vec2( float( i - K ), float( j - K ) );
			float d = csmUnpackDepth( texture2D( uCsmAtlas, clamp( ( base + o + 0.5 ) * tx, uvMin, uvMax ) ) );
			row += ( d < recvZ + dot( dzT, o - f ) ) ? 0.0 : wxi;
		}
		lit += row * wyj;
	}
	return lit / max( sx * sy, 1e-5 );
#else
	float wx[ 8 ];
	float wy[ 8 ];
	float sx = 0.0;
	float sy = 0.0;
	for ( int i = 0; i < 8; i ++ ) {
		if ( i >= N ) break;
		float o = float( i - K );
		wx[ i ] = max( 0.0, 1.0 - abs( o - f.x ) / r );
		wy[ i ] = max( 0.0, 1.0 - abs( o - f.y ) / r );
		sx += wx[ i ];
		sy += wy[ i ];
	}
	float lit = 0.0;
	for ( int j = 0; j < 8; j ++ ) {
		if ( j >= N ) break;
		if ( wy[ j ] <= 0.0 ) continue;
		float row = 0.0;
		for ( int i = 0; i < 8; i ++ ) {
			if ( i >= N ) break;
			if ( wx[ i ] <= 0.0 ) continue;
			vec2 o = vec2( float( i - K ), float( j - K ) );
			float d = csmUnpackDepth( texture2D( uCsmAtlas, clamp( ( base + o + 0.5 ) * tx, uvMin, uvMax ) ) );
			row += ( d < recvZ + dot( dzT, o - f ) ) ? 0.0 : wx[ i ];
		}
		lit += row * wy[ j ];
	}
	return lit / max( sx * sy, 1e-5 );
#endif
}

float csmSampleCascade( const in int ci, const in vec3 wpos, const in vec3 wnrm, const in float ndl, const in float phi, const in float pixWorld ) {

	vec4 prm = uCsmParams[ ci ];
	float texelWorld = prm.x;
	float depthRange = prm.y;
	csmProxOut = 0.0;

	// Normal offset, in texels, opened up at grazing incidence. This is the
	// primary acne cure — it moves the LOOKUP, not the depth, so it cannot
	// detach the shadow the way a big depth bias does.
	// Quadratic so well-lit surfaces pay nothing (no peter-panning) while
	// near-terminator surfaces, where acne is worst, get a much bigger push.
	float g1 = 1.0 - ndl;
	float grazing = 1.0 + 4.5 * g1 * g1;
	vec3 off = wnrm * ( prm.z * grazing );

	vec4 p = uCsmMatrix[ ci ] * vec4( wpos + off, 1.0 );
	vec3 sc = p.xyz;
	csmDbgIdx = float( ci );
	float edge = min( min( sc.x, 1.0 - sc.x ), min( sc.y, 1.0 - sc.y ) );
	csmCoverOut = ( sc.z < 0.0 || sc.z > 1.0 ) ? 0.0 : smoothstep( 0.0, 0.03, edge );
	if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z < 0.0 || sc.z > 1.0 ) { csmDbgIn = 0.0; return 1.0; }
	csmDbgIn = 1.0;

	// Slope-scaled constant depth bias, expressed in world units then converted
	// to the cascade's normalised depth. tan(acos(ndl)) = sqrt(1-n^2)/n.
	float slope = clamp( sqrt( max( 0.0, 1.0 - ndl * ndl ) ) / max( ndl, 0.12 ), 0.0, 6.0 );
	float recvZ = sc.z - ( prm.w * ( 1.0 + slope * 1.5 ) ) / depthRange;

	vec4 rect = uCsmRect[ ci ];
	vec2 uv = rect.xy + sc.xy * rect.zw;
	vec2 uvMin = rect.xy + uCsmAtlasTexel * 1.5;
	vec2 uvMax = rect.xy + rect.zw - uCsmAtlasTexel * 1.5;
	csmDbgUV = uv;
	csmDbgRecv = recvZ;
	// PERF: this fetch only feeds the debug views (uniform branch).
	if ( uCsmMisc.y > 0.5 ) csmDbgAtlas = csmUnpackDepth( texture2D( uCsmAtlas, uv ) );
	if ( uCsmTune.z > 0.5 ) return csmGridFilter( ci, uv, recvZ, uvMin, uvMax, texelWorld, depthRange );

	// ---- resolution-aware filter floor ------------------------------------
	// pixWorld is the world size of ONE DEVICE PIXEL on this surface (see the
	// note in csmApply). The filter footprint is never allowed to fall below
	// uCsmSky.w of those, in world units, so a shadow feature that is collapsing
	// toward a pixel gets WIDENED instead of point-sampled off a staircase.
	// This is what makes the filter distance-invariant: the same rooftop shadow
	// keeps the same edge width in PIXELS whether the camera is at 60 or 340.
	float floorTexels = ( uCsmSky.w * pixWorld ) / texelWorld;
	// ...but never wider than the tap budget can actually filter. A disk needs
	// about uCsmTune.x taps per texel^2 to keep its spacing near a texel, so
	// with CSM_MAX_TAPS in hand there is a hard ceiling on a WELL-SAMPLED
	// radius; past it, widening adds sampling noise faster than it removes edge
	// sharpness. The region shot is where that bites: a pixel there projects to
	// ~3 world units on a foreshortened roof, and the uncapped floor asked for a
	// 5-texel disk that 8 taps cannot fill — rooftop hf1 excess went 0.186
	// unfiltered -> 0.240 with the floor in, and only came back to 0.186 once
	// the tap ramp below paid for it. Capping the floor at the well-sampled
	// radius gets the same result without the taps. Only the FLOOR is capped: a
	// genuinely soft, wide-gap penumbra is art direction, not antialiasing, and
	// keeps its full width.
	if ( uCsmTune.x > 0.0 ) {
		floorTexels = min( floorTexels, sqrt( float( CSM_MAX_TAPS ) / uCsmTune.x ) );
	}
	float floorWorld = floorTexels * texelWorld;

	// ---- blocker search (PCSS step 1) -------------------------------------
	// The search must cover at least the filter footprint, or the "no blocker
	// found -> fully lit" early-out cuts a hard, aliased edge through the outer
	// half of the very penumbra we are about to widen.
	float searchTexels = clamp( max( uCsmSoft.y / texelWorld, floorTexels ), 1.0, 16.0 );
	vec2 searchStep = searchTexels * uCsmAtlasTexel;
	float nSearch = uCsmTaps.y;
	float sum = 0.0;
	float hits = 0.0;
	for ( int t = 0; t < CSM_MAX_SEARCH; t ++ ) {
		if ( float( t ) >= nSearch ) break;
		vec2 o = csmVogel( float( t ), nSearch, phi ) * searchStep;
		float d = csmUnpackDepth( texture2D( uCsmAtlas, clamp( uv + o, uvMin, uvMax ) ) );
		if ( d < recvZ ) { sum += d; hits += 1.0; }
	}
	if ( hits < 0.5 ) return 1.0;                       // fully lit: early out

	// ---- penumbra estimate (PCSS step 2) ----------------------------------
	float gap = max( 0.0, ( recvZ - sum / hits ) * depthRange );
	csmProxOut = exp2( - gap / max( uCsmSky.x, 0.01 ) );      // see csmProxOut
	// The floor is applied AFTER the world-space clamp on purpose: maxPenumbra
	// is an art-direction cap on how soft a shadow may look, but it must never
	// force the filter below the sampling limit of the framebuffer.
	float penumbra = max( clamp( gap * uCsmSoft.z, uCsmSoft.x, uCsmSoft.w ), floorWorld );
	float radius = clamp( penumbra / texelWorld, 0.55, 16.0 );

	// ---- filter (PCSS step 3) ---------------------------------------------
	// Tap count follows the footprint. A Vogel disk of n taps over r texels has
	// a tap spacing of roughly 2r/sqrt(n); once that spacing exceeds a tap's own
	// one-texel support the disk samples through gaps, which is undersampling
	// and lands right back at the 1-pixel period. uCsmTune.x is the tap density
	// (taps per texel^2 of disk area) needed to keep the spacing near a texel.
	// It only ever ADDS taps to a kernel the resolution floor has just widened,
	// and it is capped at CSM_MAX_TAPS, so the near cascade — where the radius
	// is small — still runs the quality level's budget and pays nothing.
	float nPcf = uCsmTaps.x;
	if ( uCsmTune.x > 0.0 ) {
		nPcf = min( float( CSM_MAX_TAPS ), max( nPcf, ceil( uCsmTune.x * radius * radius ) ) );
	}
	if ( radius <= 0.75 || nPcf < 1.5 ) {
		return csmTap( uv, recvZ, uvMin, uvMax );
	}
	vec2 step2 = radius * uCsmAtlasTexel;
	float lit = 0.0;
	float n = 0.0;
	for ( int t = 0; t < CSM_MAX_TAPS; t ++ ) {
		if ( float( t ) >= nPcf ) break;
		vec2 o = csmVogel( float( t ), nPcf, phi ) * step2;
		lit += csmTap( uv + o, recvZ, uvMin, uvMax );
		n += 1.0;
	}
	return lit / max( n, 1.0 );
}

vec3 csmCascadeDebugTint( const in int ci ) {
	if ( ci == 0 ) return vec3( 1.35, 0.45, 0.45 );
	if ( ci == 1 ) return vec3( 0.45, 1.35, 0.50 );
	if ( ci == 2 ) return vec3( 0.45, 0.60, 1.45 );
	return vec3( 1.30, 1.20, 0.40 );
}

// Last shadow term (direct/cast) and the last contact proximity, so the
// INDIRECT terms can be occluded too — but occluded by the right thing.
//
// History, because this has now been wrong in both directions:
//
//   Round 1: the sky IBL ignored shadows completely. Measured at noon, what
//   lights a ground pixel splits as sun (direct) ~10 %, hemi + ambient ~13 %,
//   sky IBL (envMap) ~44 %; a shadow that only removed the direct term took a
//   tenth of the light off the ground and was invisible.
//
//   Round 2 (the over-correction): indirect occlusion was driven straight off
//   the CAST-SHADOW term, at 0.72 of the IBL and 0.55 of the hemi/ambient. That
//   is a category error. Being sun-blocked says nothing about how much SKY a
//   point can see: open road lying in the long shadow of a tower still sees the
//   entire dome. Measured result: shadowed road median luma 5.3 against 74.3
//   lit — 14:1, with 1.16 % of the frame below luma 4. Cities: Skylines shadows
//   are nowhere near that empty.
//
// The fix: indirect occlusion is driven by SKY VISIBILITY, not by the cast
// shadow. Sky visibility is estimated from csmProxOut (how close the blocker
// actually is), so a street canyon / wall base loses real sky while open
// shadowed ground barely loses any. Screen-space cavity AO (post.js) is the
// other half of the same signal and is applied downstream; these caps are
// deliberately small so the two do not multiply into a black hole.
float csmLastShadow = 1.0;
float csmLastProx   = 0.0;
// Receiver orientation weight for the sky occlusion (r6). A KEY-FACING wall in
// a neighbour's cast shadow used to lose 50-60% of its fill (sun-blocked), while
// the same building's AWAY-facing wall is never 'sun-blocked' (N.L <= 0 returns
// early) and kept 100%: the shadowed building's lit side went DARKER than its
// dark side — an inverted, flat three-tone (critic r5: 'left and right walls
// nearly the same'). The sky a wall loses to a distant caster is small anyway;
// the deep open-shadow occlusion is for ground and roofs, so walls keep their fill.
float csmLastUpW    = 1.0;

// How much of the sky dome this fragment loses. 0 = full dome (lit ground, or
// open ground that is merely sun-blocked), 1 = tucked right under a caster.
float csmSkyOcclusion() {
	float sunBlocked = 1.0 - csmLastShadow;
	// uCsmSky.y is the floor: even wide-open shadowed ground loses a little sky,
	// because the caster that is blocking the sun subtends some solid angle.
	return sunBlocked * mix( uCsmSky.y, 1.0, csmLastProx ) * csmLastUpW;
}

// hemi + ambient + light probes
float csmIndirectScale() {
	if ( uCsmMisc.y > 0.5 ) return 0.0;                    // debug view: no fill
	return 1.0 - uCsmTaps.w * csmSkyOcclusion();
}

// diffuse image-based lighting (the sky PMREM).
float csmIblScale() {
	if ( uCsmMisc.y > 0.5 ) return 0.0;
	return 1.0 - uCsmFill.x * csmSkyOcclusion();
}

// Low-sun skylight tint for the DIFFUSE sky IBL only (see _skylightGrade() in
// lighting.js). The PMREM is a snapshot of a dome whose ZENITH stays Rayleigh
// blue long after the sun has reddened, and a horizontal surface integrates
// mostly zenith — so at golden hour the single largest contributor to a road
// pixel arrives ice blue while the key light is 2.8:1 warm. This rotates the
// diffuse sky irradiance toward the horizon band the low sun actually lights,
// at close to constant luminance. Specular is deliberately NOT tinted: a
// mirrored sky must keep matching the dome the player can see.
vec3 csmIblTint() {
	return uCsmIblTint;
}

// specular image-based lighting. Kept gentler than the diffuse term so glass
// and metal keep a live reflection inside a shadow instead of going dead.
float csmSpecularScale() {
	if ( uCsmMisc.y > 0.5 ) return 0.0;
	return 1.0 - uCsmFill.y * csmSkyOcclusion();
}

// ---- WORLD-SPACE AMBIENT OCCLUSION (round 2 of the iso art direction) -----
// The blind critic's biggest gap: "wall bases, the undersides of cornices,
// sills, balconies and roof ledges, and the inside corners are lit evenly ...
// the ledges look like they float, and buildings sit on their lots with no
// anchoring darkness". ref04 (Blender) puts a soft, fairly WIDE darkening
// gradient under every overhang and wherever a wall meets the ground or roof
// deck. Screen-space AO (post.js) is limited to what the depth buffer shows and
// its radius; the voxel AO (voxel.js) only reaches a voxel or so. Neither can
// produce a gradient a couple of world units wide that is stable under
// camera motion.
//
// This term is computed from a 2-layer HEIGHT VOLUME the rig renders top-down
// over the region the camera is looking at (see _aoUpdate): for every ground
// column, R = the highest surface in it (the top) and G = the LOWEST (r7b)
// DOWN-FACING surface in it (the underside of the topmost solid, or "none").
// A world point p is solid when  underside < p.y < top.  That is enough to
// describe a building (solid to the ground: no underside), a cornice, sill,
// balcony, awning or tree canopy (solid between its underside and top, open
// below), the ground and a roof deck. Occlusion is then a fixed, cosine-
// distributed hemisphere kernel around the normal, each tap soft-tested for
// "inside" — so it is smooth (no noise, no temporal swim), view-independent,
// and it reaches under every overhang the way ref04's GI does.
//
// It occludes the INDIRECT light (hemi + ambient + sky IBL) — physically the
// only thing AO should touch — with Jimenez' multi-bounce fit so an occluded
// orange corner goes DEEPER ORANGE, not grey; plus a small share of the direct
// key (uAoParams.y) so a sunlit wall still shows the soft tuck at its foot.
// ROUND 7 REWRITE (critic r6: "no tight dark AO line where the walls meet the
// plinth, where props meet the paving, or in the inside corners under
// cornices and awnings, so objects float"). The old per-fragment kernel (6
// directions x 2 taps at 1 and 3 units) poked the height map so sparsely that
// every prop footprint was stamped around itself as shifted square ghosts —
// the "blocky stair-step blotches" that got it switched off. Now:
//  1. GROUND AO is solved ONCE per height-volume refresh, in map space
//     (AO_GROUND_FRAG: 16 horizon directions x 8 steps inside aoRadius,
//     each the max horizon sine with a distance falloff), then blurred with a
//     height-aware separable filter (AO_BLUR_FRAG), into the B channel.
//     Dense + filtered = no ghosts; view-independent = no swim.
//  2. A fragment reads it with a height-aware bilinear (csmAoRead): a roof
//     never picks up the ground's value at its edge and vice versa, so the
//     darkest texel sits exactly at the contact, not a texel off it.
//      - up-facing: the value at its own column (or, if something covers it —
//        an awning, umbrella, canopy — a cover term from the underside height);
//      - walls: the ground value just in front of the wall, faded out over
//        aoContact units of height above that ground (the tight wall-foot
//        line, continuous with the ground's line = one crease), a broad
//        aoGradHeight gradient (walls lighter toward the top, ref04/ref05),
//        a crease under any exposed underside in front (cornice, sill,
//        awning, balcony), and a narrow-gap term where the column in front is
//        solid at this height.
// Channel layout of uAoMap (RGBA half-float): R top + 20, G underside code
// (see AO_FLOOD_FRAG), B blurred ground visibility (of the FLOOR for an
// overhang column), A validated floor under the overhang + 20 (<= 0: none).
// r7b: an 'overhang column' (awning, cornice lip, umbrella over paving) now
// carries the paving under it, so the wall-foot line runs right up to the
// wall under a cornice/awning instead of stopping at the overhang's edge
// (critic r6: "no tight dark AO line where the walls meet the plinth"), and
// aoTight adds a thin contact crease on top of the broader aoRadius falloff.
uniform sampler2D uAoMap;
uniform vec4 uAoXf;                        // u = x * x + y, v = z * z + w
uniform vec4 uAoParams;                    // x indirect strength, y direct share, z on (> 0.5), w edge fade (uv)
uniform vec4 uAoTune;                      // x world units per texel, y height tolerance, z 1 / map res, w fill saturation
uniform vec4 uAoShape;                     // x power, y contact fade height, z gradient height, w gradient depth
uniform vec4 uAoCover;                     // x cover vis (low overhang), y crease strength, z crease distance, w gap vis
uniform vec4 uAoGrad;                      // x whole-wall gradient depth (fill), y its curve exponent (r7b), z fill floor, w its knee (r9)

float csmAoVis = - 1.0;                    // cached per fragment
float csmAoGradV = 1.0;                    // broad wall gradient: fill only (set by csmWorldAO)

// One texel of the height-aware bilinear read. mode 0 (up-facing receiver at
// height y): 'recv' = this column's top IS the receiver; 'cov' = something
// above it (cover vis in .z). mode 1 (wall at height y): 'open' = column top
// below y (ground/roof in front: ao in .x, top in .y); 'over' = exposed
// underside above y (crease); otherwise solid at y (narrow gap).
void csmAoTexel( const in vec2 uv, const in float wb, const in float y, const in float mode,
		inout vec4 accA, inout vec4 accW ) {
	vec4 t = texture2D( uAoMap, uv );
	if ( t.r <= 0.0 ) return;                            // nothing rendered here
	float top = t.r - 20.0;
	float und = t.g > 0.0 ? t.g - 20.0 : - 1e4;          // exposed underside (< -1e3: none / enclosed)
	float flo = t.a > 0.5 ? t.a - 20.0 : - 1e4;          // validated floor under the overhang (r7b)
	// 'overhang column': an exposed underside with a real floor under it
	// (awning, cornice, umbrella, canopy over paving). Its B value belongs to
	// that FLOOR, not to the top (see AO_GROUND_FRAG).
	float isOv = ( und > - 1e3 && flo > - 1e3 && flo < und - 0.05 ) ? 1.0 : 0.0;
	float tol = uAoTune.y + 0.0015 * abs( top );         // half-float step grows with height
	if ( mode < 0.5 ) {
		float cvU = und > y ? mix( uAoCover.x, 1.0, smoothstep( 0.25, 5.0, und - y ) ) : uAoCover.x;
		float rT = 1.0 - smoothstep( tol, 2.5 * tol, abs( top - y ) );
		float rF = isOv * ( 1.0 - smoothstep( tol, 2.5 * tol, abs( flo - y ) ) );
		float r = min( 1.0, rT + rF );
		float v = ( rF * t.b * cvU + rT * mix( t.b, 1.0, isOv ) ) / max( rT + rF, 1e-4 );
		float above = ( 1.0 - r ) * smoothstep( tol, 2.5 * tol, top - y );
		accA.x += wb * r * v;       accW.x += wb * r;
		accA.y += wb * above * cvU; accW.y += wb * above;
	} else {
		// wall at height y looking at the column in front of it:
		//  openT: the column's top is below us (ground / roof deck in front)
		//  openF: we are under its exposed overhang, standing on its floor
		//  openX: under an overhang with no usable floor (no contact term)
		//  solid: the column is solid at our height (narrow gap)
		float openT = 1.0 - smoothstep( 0.0, tol, top - y );
		float under = ( 1.0 - openT ) * step( y, und );
		float openF = under * isOv * ( 1.0 - smoothstep( 0.0, tol, flo - y ) );
		float openX = under - openF;
		float solid = max( 1.0 - openT - under, 0.0 );
		float hT = max( y - top, 0.0 ), hF = max( y - flo, 0.0 );
		float vT = mix( mix( t.b, 1.0, isOv ), 1.0, smoothstep( 0.0, uAoShape.y, hT ) );
		float vF = mix( t.b, 1.0, smoothstep( 0.0, uAoShape.y, hF ) );
		float gT = mix( 1.0 - uAoShape.w, 1.0, smoothstep( 0.0, uAoShape.z, hT ) );
		float gF = mix( 1.0 - uAoShape.w, 1.0, smoothstep( 0.0, uAoShape.z, hF ) );
		accA.x += wb * ( openT * vT + openF * vF + openX );
		accA.y += wb * ( openT * gT + openF * gF + openX );
		accW.x += wb * ( openT + openF + openX );
		accA.z += wb * under * ( und - y );  accW.y += wb * under;
		accW.z += wb * solid;
		accA.w += wb * ( openT * top + openF * flo );  accW.w += wb * ( openT + openF );
	}
}

// 4-texel bilinear with per-texel masks (see csmAoTexel).
void csmAoRead( const in vec2 uv, const in float y, const in float mode, out vec4 accA, out vec4 accW ) {
	accA = vec4( 0.0 ); accW = vec4( 0.0 );
	vec2 st = uv / uAoTune.z - 0.5;
	vec2 i0 = floor( st );
	vec2 f = st - i0;
	vec2 b = ( i0 + 0.5 ) * uAoTune.z;
	float d = uAoTune.z;
	csmAoTexel( b,                   ( 1.0 - f.x ) * ( 1.0 - f.y ), y, mode, accA, accW );
	csmAoTexel( b + vec2( d, 0.0 ),  f.x * ( 1.0 - f.y ),           y, mode, accA, accW );
	csmAoTexel( b + vec2( 0.0, d ),  ( 1.0 - f.x ) * f.y,           y, mode, accA, accW );
	csmAoTexel( b + vec2( d, d ),    f.x * f.y,                     y, mode, accA, accW );
}

// Sky visibility 0..1 from the height volume (1 = nothing nearby).
float csmWorldAO( const in vec3 viewNormal ) {
	if ( csmAoVis >= 0.0 ) return csmAoVis;
	csmAoVis = 1.0;
	if ( uAoParams.z < 0.5 ) return 1.0;
	vec3 P = vCsmWorldPos + uCsmOrigin;
	vec2 uv0 = vec2( P.x * uAoXf.x + uAoXf.y, P.z * uAoXf.z + uAoXf.w );
	vec2 edge = min( uv0, 1.0 - uv0 );
	float regionFade = clamp( min( edge.x, edge.y ) / max( uAoParams.w, 1e-4 ), 0.0, 1.0 );
	if ( regionFade <= 0.0 ) return 1.0;
	vec3 N = csmInvXformDir( viewNormal, viewMatrix );
	vec4 A, W;
	float vis = 1.0;
	if ( N.y > 0.55 ) {
		csmAoRead( uv0, P.y, 0.0, A, W );
		float wt = W.x + W.y;
		if ( wt > 1e-3 ) vis = ( A.x + A.y ) / wt;
	} else if ( N.y > - 0.55 ) {
		vec2 nh = normalize( N.xz + vec2( 1e-5, 0.0 ) );
		vec2 pf = P.xz + nh * ( 1.35 * uAoTune.x + 0.02 );
		csmAoRead( vec2( pf.x * uAoXf.x + uAoXf.y, pf.y * uAoXf.z + uAoXf.w ), P.y, 1.0, A, W );
		float wt = W.x + W.z;
		if ( wt > 1e-3 ) {
			float vOpen = W.x > 1e-4 ? A.x / W.x : 1.0;
			float vGrad = W.x > 1e-4 ? A.y / W.x : 1.0;
			// crease under an exposed underside in front (cornice, sill, awning)
			float vOver = W.y > 1e-4 ? 1.0 - uAoCover.y * exp( - ( A.z / W.y ) / uAoCover.z ) * min( W.y / wt, 1.0 ) : 1.0;
			vis = ( W.x * vOpen + W.z * uAoCover.w ) / wt * vOver;
			// r7b whole-wall gradient (critic r6: "the dark faces are one flat
			// value ... a subtle vertical gradient that gets lighter toward the
			// top"): the fill on a wall rises from its foot to the top of the
			// solid it belongs to (read one texel BEHIND the face), so every
			// block — a bench or a tower — shades darker at the bottom.
			if ( uAoGrad.x > 0.0 && W.w > 1e-4 ) {
				vec2 pb = P.xz - nh * ( 1.35 * uAoTune.x + 0.02 );
				vec4 ts = texture2D( uAoMap, vec2( pb.x * uAoXf.x + uAoXf.y, pb.y * uAoXf.z + uAoXf.w ) );
				float fl = A.w / W.w;
				float tself = ts.r > 0.0 ? ts.r - 20.0 : P.y;
				float fr = clamp( ( P.y - fl ) / max( tself - fl, 0.5 ), 0.0, 1.0 );
				vGrad = min( vGrad, mix( 1.0 - uAoGrad.x, 1.0, pow( fr, uAoGrad.y ) ) );
			}
			csmAoGradV = mix( 1.0, mix( 1.0 - uAoShape.w * 0.5, vGrad, W.x / wt ), regionFade );
		}
	}
	csmAoVis = pow( clamp( mix( 1.0, vis, regionFade ), 0.0, 1.0 ), uAoShape.x );
	return csmAoVis;
}

// Multiplier for the INDIRECT irradiance (hemi/ambient and the sky IBL).
// Multi-bounce (Jimenez et al. 2016, "Practical Realtime Strategies for
// Accurate Indirect Occlusion"): bright albedos lose less and keep their hue.
// 'fill saturation' (uAoTune.w) is the same physics one step further: the fill
// that reaches a wall has mostly bounced off the city around it, so it carries
// the surface colour — this is what keeps the dark right-hand faces a rich,
// darker version of the wall colour (ref04) instead of grey-purple / beige.
vec3 csmAoIndirect( const in vec3 viewNormal, const in vec3 albedo ) {
	if ( uCsmMisc.y > 0.5 ) return vec3( 1.0 );
	float lum = dot( albedo, vec3( 0.2126, 0.7152, 0.0722 ) );
	vec3 hue = clamp( albedo / max( lum, 0.02 ), vec3( 0.55 ), vec3( 1.9 ) );
	vec3 sat = mix( vec3( 1.0 ), hue, uAoTune.w );
	if ( uAoParams.z < 0.5 ) return sat;
	float ao = ( 1.0 - uAoParams.x * ( 1.0 - csmWorldAO( viewNormal ) ) ) * csmAoGradV;
	// r9 fill floor (critic r8: "near-black crevices under awnings, between
	// rooftop props and at plinth bases"). The fill in a crevice was the
	// PRODUCT of several independent occluders (cast-shadow sky loss, this
	// world AO at pow 2, the crease under an overhang, the wall gradient,
	// materials' baked voxel AO), so a recess ran to ~1-3% of its open fill —
	// black. ref04's Blender AO never goes below roughly half the face value.
	// A smooth max (knee uAoGrad.w) keeps every light, soft gradient exactly as
	// it was and only stops the deep end at uAoGrad.z, so crevices stay a
	// colourful mid-tone. Open cast shadows (csmIndirectScale) are untouched.
	if ( uAoGrad.z > 0.0 ) {
		float kf = max( uAoGrad.w, 1e-3 );
		float hf = clamp( 0.5 + 0.5 * ( ao - uAoGrad.z ) / kf, 0.0, 1.0 );
		ao = mix( uAoGrad.z, ao, hf ) + kf * hf * ( 1.0 - hf );
	}
	vec3 a = 2.0404 * albedo - 0.3324;
	vec3 b = - 4.7951 * albedo + 0.6417;
	vec3 c = 2.7552 * albedo + 0.6903;
	vec3 mb = max( vec3( ao ), ( ( ao * a + b ) * ao + c ) * ao );
	return mb * sat;
}

// ---- DIRECTIONAL WALL FILL (light r8) ------------------------------------
// Critic r7 (picked the reference): "in our downtown the left and right walls
// sit at almost the same mid value ... the reference gives every building a
// bright warm left face and a clearly darker but still colourful cool right
// face". Measured (iso-mid, faces masked by a normal render): right/left sRGB
// luma 0.80-0.90 on neutral and blue walls (ref05 ~0.60-0.68). The hemi light
// and the studio IBL are rotationally symmetric about Y, so every wall got the
// SAME fill whichever way it faced, and in a dense downtown — where half the
// key-facing walls stand in a neighbour's cast shadow — fill is all there is,
// so the two sides converged. A real clear sky is not symmetric: the half of
// the dome around the sun (plus the sunlit street it bounces off) is several
// times brighter than the half behind you. So walls turned AWAY from the key
// take less of the fill, tinted a touch cool (they see blue sky, not sunlit
// paving), and walls turned TOWARD it take a little more — that keeps a
// shadowed key-side wall a clear step above its own far wall. Horizontal
// faces (roofs, ground) are untouched, so tops and cast shadows keep their
// values; off at night / dusk / overcast (uCsmWallFill.z = the daytime art
// amount). Applied to hemi + ambient AND the diffuse sky IBL.
vec3 csmWallFill( const in vec3 viewNormal ) {
	if ( uCsmWallFill.z <= 0.0 || uCsmMisc.y > 0.5 ) return vec3( 1.0 );
	// Light w4r2: inside a cast shadow an up-facing surface sees only the blue
	// dome (the warm key and the sunlit paving around it are blocked), so the
	// fill that is left there is tinted cool: ref05's shadows on its warm tan
	// plinths are blue-grey (B/R ~1.0 against ~0.7 lit). Luminance ~1, so the
	// shadow keeps its measured value; walls are left to the away-wall tint.
	vec3 cool = mix( vec3( 1.0 ), uCsmShadowTint.rgb, ( 1.0 - csmLastShadow ) * csmLastUpW * uCsmShadowTint.w );
	vec3 wn = csmInvXformDir( viewNormal, viewMatrix );
	float nh = length( wn.xz );
	float kh = length( uCsmKeyDirW.xz );
	if ( nh < 1e-3 || kh < 1e-3 ) return cool;
	float f = dot( wn.xz / nh, uCsmKeyDirW.xz / kh );    // +1 faces the key, -1 turned away
	float wall = ( 1.0 - smoothstep( 0.35, 0.85, abs( wn.y ) ) ) * uCsmWallFill.z;
	float away = smoothstep( 0.0, 0.55, - f ) * wall;
	float toward = smoothstep( 0.0, 0.55, f ) * wall;
	vec3 awayMul = mix( vec3( 1.0 ), uCsmWallTint * ( 1.0 - uCsmWallFill.x ), away );
	return cool * awayMul * ( 1.0 + uCsmWallFill.y * toward );
}

// Light w4r2: the same away-wall cut, applied (at uCsmWallFill.w of its
// strength, untinted) to the SPECULAR sky reflection. The studio env is
// symmetric, so glass and glossy trim on the far wall mirrored the same bright
// sky as the key-side wall and downtown towers kept a flat, pastel right face
// (critic w4r1). A real far wall reflects the dim half of the sky.
float csmWallSpec( const in vec3 viewNormal ) {
	if ( uCsmWallFill.z <= 0.0 || uCsmWallFill.w <= 0.0 || uCsmMisc.y > 0.5 ) return 1.0;
	vec3 wn = csmInvXformDir( viewNormal, viewMatrix );
	float nh = length( wn.xz );
	float kh = length( uCsmKeyDirW.xz );
	if ( nh < 1e-3 || kh < 1e-3 ) return 1.0;
	float f = dot( wn.xz / nh, uCsmKeyDirW.xz / kh );
	float wall = ( 1.0 - smoothstep( 0.35, 0.85, abs( wn.y ) ) ) * uCsmWallFill.z;
	float away = smoothstep( 0.0, 0.55, - f ) * wall;
	return 1.0 - uCsmWallFill.x * uCsmWallFill.w * away;
}

// Multiplier for the direct key (a small artistic share, see above).
float csmAoDirect( const in vec3 viewNormal ) {
	if ( uAoParams.z < 0.5 || uAoParams.y <= 0.0 ) return 1.0;
	return 1.0 - uAoParams.y * ( 1.0 - csmWorldAO( viewNormal ) );
}

// The single entry point a material splices in. Returns the direct light colour
// modulated by the cascaded shadow (and, in debug mode, the cascade tint).
vec3 csmApply( const in vec3 lightColor, const in vec3 viewNormal, const in vec3 viewLightDir ) {

	if ( uCsmCount < 0.5 ) return lightColor;
	csmDPdx = dFdx( vCsmWorldPos );
	csmDPdy = dFdy( vCsmWorldPos );

	float ndl = dot( viewNormal, viewLightDir );
	if ( ndl <= 0.001 ) return lightColor;              // already unlit by N.L

	vec3 wnrm = csmInvXformDir( viewNormal, viewMatrix );
	float vz = vCsmViewZ;

	// Kernel rotation. uCsmTaps.z is the rotation BLOCK SIZE in device pixels:
	//   0   = no rotation at all
	//   1   = a fresh rotation per pixel  (the old behaviour)
	//   >=2 = one rotation per NxN screen block
	//
	// Per-pixel rotation is the textbook way to hide a small tap budget, and it
	// is also why every rooftop penumbra was fizzing with blue confetti: it
	// makes each pixel an INDEPENDENT 16-sample Bernoulli estimate, i.e. white
	// noise, i.e. energy at exactly the 1-pixel period. Measured on a sunlit
	// rooftop penumbra: hf1 4.435 with shadows on vs 0.598 with shadowStrength
	// 0 — a 7.4x increase caused purely by this term. There is no shadow
	// denoise pass to clean it up afterwards (the AO buffer gets one; the
	// shadow term is computed inline in the forward pass and never lands in a
	// buffer that could be bilaterally blurred without post.js owning it).
	//
	// Quantising the rotation to a block makes neighbouring pixels share a
	// kernel, so the shadow term becomes a smooth function of position again
	// and the residual noise moves from the 1-pixel period to the block period,
	// where it is far less visible and where the existing AA/DOF actually help.
	float blk = max( uCsmTaps.z, 1.0 );
	vec2 pxq = floor( gl_FragCoord.xy / blk ) * blk;
	float phi = ( uCsmTaps.z > 0.5 ) ? csmDither( pxq ) * 6.28318531 : 0.0;

	// ---- projected pixel footprint (the distance-invariance term) ----------
	// The kernel rotation above fixed stipple at ONE camera distance. It could
	// not fix the other half of the problem, which is a pure sampling-theory
	// one: the filter width was specified in WORLD units (minPenumbra, and the
	// 0.55-texel radius floor), so as the camera pulls back, the shadow edge it
	// produces collapses toward — and then below — one device pixel, and a
	// sub-pixel edge point-sampled once per pixel is aliasing by definition.
	// Measured on the rooftop probe, hf1 excess over a shadows-OFF clean plate:
	// street (close) 0.68, hero (mid) 1.14, region (far) 0.64 with only a
	// handful of surviving roof pixels — the same shader, the same settings,
	// three different answers purely from zoom.
	//
	// So: measure how much world space one DEVICE pixel covers on THIS surface,
	// and hand it to the cascade so the filter footprint can be floored there
	// (uCsmSky.w pixels' worth). Perspective footprint = viewZ * (2 tan(fov/2) /
	// drawingBufferHeight) — that is uCsmFill.w, published per frame by the rig
	// — divided by |N.V| for foreshortening, because a roof seen at a glancing
	// angle from the region camera stretches one pixel across several world
	// units along the surface. The 0.25 clamp caps that stretch at 4x so
	// near-horizon ground does not blur its shadows into soup.
	//
	// The cost is zero taps: it changes the RADIUS of the disk that is already
	// being sampled. It also makes the whole thing resolution-independent — at
	// 2x device pixel ratio the world-space blur halves on its own.
	float pixWorld = 0.0;
	if ( uCsmFill.w > 0.0 && uCsmSky.w > 0.0 ) {
		vec3 toCam = cameraPosition - ( vCsmWorldPos + uCsmOrigin );
		float dcam = max( length( toCam ), 1e-3 );
		float nv = abs( dot( wnrm, toCam / dcam ) );
		pixWorld = vz * uCsmFill.w / max( nv, 0.25 );
	}

	float shadow = 0.0;
	float wsum = 0.0;
	float prox = 0.0;
	vec3 tint = vec3( 0.0 );

	if ( uCsmTune.y > 0.5 ) {
		// Iso layout: the tight cascade 0 wherever it covers the fragment, the
		// whole-view cascade 1 outside it (tall roofs above the fit height).
		float s0 = csmSampleCascade( 0, vCsmWorldPos, wnrm, ndl, phi, pixWorld );
		float p0 = csmProxOut;
		float c0 = csmCoverOut;
		shadow = s0; prox = p0; tint = csmCascadeDebugTint( 0 ); wsum = 1.0;
		if ( c0 < 0.999 && uCsmCount > 1.5 ) {
			float s1 = csmSampleCascade( 1, vCsmWorldPos, wnrm, ndl, phi, pixWorld );
			shadow = mix( s1, s0, c0 );
			prox = mix( csmProxOut, p0, c0 );
			tint = mix( csmCascadeDebugTint( 1 ), tint, c0 );
		}
	} else
	for ( int i = 0; i < CSM_MAX_CASCADES; i ++ ) {
		if ( float( i ) >= uCsmCount ) break;
		float w = csmCascadeWeight( vz, uCsmSplits[ i ] );
		if ( w <= 0.0001 ) continue;
		shadow += w * csmSampleCascade( i, vCsmWorldPos, wnrm, ndl, phi, pixWorld );
		prox += w * csmProxOut;
		tint += w * csmCascadeDebugTint( i );
		wsum += w;
	}

	if ( wsum <= 0.0001 ) return lightColor;
	shadow /= wsum;
	prox /= wsum;
	tint /= wsum;

	// Crispen the penumbra ramp. A pure PCSS average spends a lot of pixels at
	// 0.4-0.6, which reads as haze rather than as a shadow with an edge; an
	// S-curve pushes those toward the umbra/penumbra without deepening the core.
	shadow = mix( shadow, shadow * shadow * ( 3.0 - 2.0 * shadow ), uCsmFill.z );

	// Distance fade so the far edge of the last cascade never shows a seam.
	float fade = clamp( ( uCsmMisc.w - vz ) / max( 0.001, uCsmMisc.w - uCsmMisc.z ), 0.0, 1.0 );
	// Terminator fade: at grazing N.L no bias can win, and the surface is
	// already ~unlit, so hand it back to N.L instead of letting acne through.
	float term = smoothstep( 0.04, 0.34, ndl );
	shadow = mix( 1.0, shadow, fade * term * uCsmMisc.x );
	csmLastShadow = shadow;
	csmLastProx = clamp( prox, 0.0, 1.0 ) * fade * term;
	csmLastUpW = smoothstep( 0.2, 0.7, wnrm.y );

	vec3 outCol = lightColor * shadow;

	// ---- debug views (uCsmMisc.y; 0 = off) ---------------------------------
	// These are development instrumentation, kept in the shipping shader
	// because the branch is uniform and costs nothing when disabled. Each mode
	// floods the DIRECT term (and csmIndirectScale()/csmIblScale() return 0 in
	// debug, so the fill does not wash it out) — the result is still modulated
	// by albedo and N.L, which is fine for reading structure.
	//   1 cascade false-colour   2 shadow term (grey)   3 atlas UV (r=u, g=v)
	//   4 sampled atlas depth    5 receiver depth       6 signed depth delta
	//     (6: red = atlas is in front of the receiver = should be shadowed,
	//         green = behind = lit, black = fragment fell outside the cascade)
	float dm = uCsmMisc.y;
	if ( dm < 0.5 ) return outCol;

	vec3 dbg;
	if ( dm > 7.5 ) {                                                 // 8: AO map probe (r,g = uv, b = top - y)
		vec3 Pd = vCsmWorldPos + uCsmOrigin;
		vec2 uvd = vec2( Pd.x * uAoXf.x + uAoXf.y, Pd.z * uAoXf.z + uAoXf.w );
		vec2 hd = texture2D( uAoMap, uvd ).rg - 20.0;
		return vec3( fract( uvd * 4.0 ), clamp( ( hd.x - Pd.y ) * 0.5 + 0.5, 0.0, 1.0 ) ) * 1.6;
	}
	if ( dm > 6.5 ) return vec3( csmWorldAO( viewNormal ) ) * 1.6;   // 7: world AO visibility
	if ( dm < 1.5 )      dbg = tint * ( 0.30 + 0.70 * shadow );
	else if ( dm < 2.5 ) dbg = vec3( shadow );
	else if ( dm < 3.5 ) dbg = vec3( fract( csmDbgUV * 8.0 ), csmDbgIn );
	else if ( dm < 4.5 ) dbg = vec3( clamp( csmDbgAtlas, 0.0, 1.0 ) );
	else if ( dm < 5.5 ) dbg = vec3( clamp( csmDbgRecv, 0.0, 1.0 ) );
	else {
		float delta = ( csmDbgRecv - csmDbgAtlas ) * 40.0;
		dbg = csmDbgIn * vec3( clamp( delta, 0.0, 1.0 ), clamp( - delta, 0.0, 1.0 ), 0.0 );
	}
	return dbg * 6.0;
}
`;

/** Prepend to the VERTEX shader. */
export const CSM_VERTEX_PARS = /* glsl */`
uniform vec3 uCsmOrigin;
varying highp vec3  vCsmWorldPos;
varying highp float vCsmViewZ;
`;

/** Insert immediately AFTER `#include <project_vertex>` in the vertex shader. */
export const CSM_VERTEX_MAIN = /* glsl */`
	vCsmWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz - uCsmOrigin;
	vCsmViewZ = - mvPosition.z;
`;

// The one line inside <lights_fragment_begin> we hook. Sourced from the
// vendored r160 chunk at runtime so we never hard-code a copy of it.
const DIR_LIGHT_INFO_LINE = 'getDirectionalLightInfo( directionalLight, directLight );';
const INDIRECT_SPEC_LINE = '#if defined( RE_IndirectSpecular )';

let _cachedLightsChunk = null;

/**
 * The expanded, CSM-aware replacement for `#include <lights_fragment_begin>`.
 * Built by taking THREE.ShaderChunk.lights_fragment_begin verbatim and adding
 * exactly one line to the FIRST directional light (index 0 = the sun/moon).
 */
export function csmLightsFragmentBegin() {
  if (_cachedLightsChunk) return _cachedLightsChunk;
  const src = THREE.ShaderChunk.lights_fragment_begin;
  if (src.indexOf(DIR_LIGHT_INFO_LINE) < 0) {
    // Vendored three changed shape — fail loud but not fatally.
    console.warn('[LightingRig] lights_fragment_begin hook point not found; CSM disabled for this material.');
    _cachedLightsChunk = src;
    return src;
  }
  let out = src.replace(
    DIR_LIGHT_INFO_LINE,
    DIR_LIGHT_INFO_LINE +
    '\n\t\t#if ( UNROLLED_LOOP_INDEX == 0 )\n' +
    '\t\tdirectLight.color = csmApply( directLight.color, geometryNormal, directLight.direction );\n' +
    '\t\tdirectLight.color *= csmAoDirect( geometryNormal );\n' +
    '\t\t#endif'
  );
  // Second hook: occlude the indirect (hemi + ambient + probe) term by the same
  // shadow so low-sun shadows still read. See csmIndirectScale().
  if (out.indexOf(INDIRECT_SPEC_LINE) >= 0) {
    out = out.replace(
      INDIRECT_SPEC_LINE,
      '#if defined( RE_IndirectDiffuse )\n\tirradiance *= csmIndirectScale();\n\tirradiance *= csmWallFill( geometryNormal );\n' +
      '\tirradiance *= csmAoIndirect( geometryNormal, diffuseColor.rgb );\n#endif\n' + INDIRECT_SPEC_LINE
    );
  }
  // Debug views 7/8 read the lookup through a white, non-specular surface so the
  // value is not multiplied by albedo (Standard/Physical only).
  out = '#ifdef STANDARD\n\tif ( uCsmMisc.y > 6.5 ) { material.diffuseColor = vec3( 1.0 ); material.specularColor = vec3( 0.0 ); }\n#endif\n' + out;
  _cachedLightsChunk = out;
  return _cachedLightsChunk;
}

let _cachedMapsChunk = null;

/**
 * The CSM-aware replacement for `#include <lights_fragment_maps>`.
 *
 * This is the third splice (the contract's §3.8.3 documented two) and it is the
 * one that makes shadows visible in the shipping game. `lights_fragment_begin`
 * can only reach `irradiance` — hemisphere + ambient + light probes. The sky
 * PMREM's contribution lands in `iblIrradiance`, which is accumulated LATER, in
 * `lights_fragment_maps`, and was therefore completely un-shadowed. Measured on
 * the real city at noon it is ~44 % of everything that lights a ground pixel
 * (the sun is ~10 %), so a shadow that could not touch it could not be seen.
 *
 * Adds three lines, guarded exactly like the chunk's own blocks:
 *   iblIrradiance *= csmIblScale();      // diffuse sky light, shadowed
 *   iblIrradiance *= csmIblTint();       // diffuse sky light, low-sun re-grade
 *   radiance      *= csmSpecularScale(); // specular sky reflection
 *
 * The tint is a SEPARATE statement on purpose: selfTest() asserts on the exact
 * text of the csmIblScale() line, and keeping the two independent means the
 * shadow hook and the colour hook can be edited without disturbing each other.
 */
export function csmLightsFragmentMaps() {
  if (_cachedMapsChunk) return _cachedMapsChunk;
  const src = THREE.ShaderChunk.lights_fragment_maps;
  _cachedMapsChunk = src +
    '\n#if defined( RE_IndirectDiffuse )\n\tiblIrradiance *= csmIblScale();\n\tiblIrradiance *= csmIblTint();\n\tiblIrradiance *= csmWallFill( geometryNormal );\n' +
    '\tiblIrradiance *= csmAoIndirect( geometryNormal, diffuseColor.rgb );\n#endif\n' +
    '#if defined( RE_IndirectSpecular )\n\tradiance *= csmSpecularScale();\n\tradiance *= csmWallSpec( geometryNormal );\n#endif\n';
  return _cachedMapsChunk;
}

/**
 * Splice CSM into an already-created `shader` object (the argument of
 * `onBeforeCompile`). `uniforms` must be the shared bag from
 * `rig.getShaderUniforms()`.
 *
 * Safe to call on MeshStandard/Physical/Lambert/Phong/Toon derived shaders.
 */
export function csmPatchShader(shader, uniforms) {
  if (!shader || shader.__csmPatched) return shader;
  shader.__csmPatched = true;

  for (const k in uniforms) shader.uniforms[k] = uniforms[k];

  let vs = shader.vertexShader;
  if (vs.indexOf('#include <project_vertex>') >= 0) {
    vs = CSM_VERTEX_PARS + vs.replace(
      '#include <project_vertex>',
      '#include <project_vertex>' + CSM_VERTEX_MAIN
    );
  } else {
    console.warn('[LightingRig] no <project_vertex> in vertex shader; CSM varyings not wired.');
  }
  shader.vertexShader = vs;

  let fs = shader.fragmentShader;
  if (fs.indexOf('#include <lights_fragment_begin>') < 0) {
    console.warn('[LightingRig] no <lights_fragment_begin>; CSM not applied to this material.');
    return shader;
  }
  fs = fs.replace('#include <lights_fragment_begin>', csmLightsFragmentBegin());
  // Third splice: occlude the sky IBL too (see csmLightsFragmentMaps).
  if (fs.indexOf('#include <lights_fragment_maps>') >= 0) {
    fs = fs.replace('#include <lights_fragment_maps>', csmLightsFragmentMaps());
  }
  // Debug view 7 (world AO): overwrite the final colour with the raw visibility
  // so nothing downstream (albedo, sky fill, rim, emissive) can mask it.
  if (fs.indexOf('#include <dithering_fragment>') >= 0) {
    fs = fs.replace('#include <dithering_fragment>',
      '#include <dithering_fragment>\n\tif ( uCsmMisc.y > 6.5 && uCsmMisc.y < 7.5 ) gl_FragColor.rgb = vec3( csmWorldAO( normal ) );');
  }
  shader.fragmentShader = CSM_FRAGMENT_PARS + fs;
  return shader;
}

// ---------------------------------------------------------------------------
// Shadow caster (depth) material. Ours, not three's — see csmUnpackDepth().
// Uses the stock chunks so instancing / skinning / morphing still work.
// ---------------------------------------------------------------------------

const CASTER_VERT = /* glsl */`
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
void main() {
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
}
`;

const CASTER_FRAG = /* glsl */`
void main() {
	highp float v = clamp( gl_FragCoord.z, 0.0, 0.9999847 );
	highp vec3 e = fract( v * vec3( 1.0, 256.0, 65536.0 ) );
	e -= e.yzz * vec3( 1.0 / 256.0, 1.0 / 256.0, 0.0 );
	gl_FragColor = vec4( e, 1.0 );
}
`;

// ---------------------------------------------------------------------------
// Light-pool (night) shaders — instanced, additive, zero per-light draw cost.
// ---------------------------------------------------------------------------

// night w4r6: stable 0..1 hash of a lamp's world position (per-lamp pool variety).
function _lampHash(x, z, salt) {
  const s = Math.sin(Math.round(x * 4) * 12.9898 + Math.round(z * 4) * 78.233 + salt * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

const POOL_VERT = /* glsl */`
attribute vec3 aTint;
attribute vec3 aParam;      // x radius, y intensity, z phase
varying vec2 vLocal;
varying vec3 vTint;
varying float vAmt;
uniform float uNight;
uniform float uTime;
void main() {
	vLocal = position.xy;
	float flicker = 0.94 + 0.06 * sin( uTime * ( 2.0 + aParam.z * 3.0 ) + aParam.z * 31.0 );
	vTint = aTint;
	vAmt = aParam.y * uNight * flicker;
	vec3 local = vec3( position.x * aParam.x * 2.0, 0.0, position.y * aParam.x * 2.0 );
	vec4 wp = instanceMatrix * vec4( local, 1.0 );
	gl_Position = projectionMatrix * modelViewMatrix * wp;
}
`;

const POOL_FRAG = /* glsl */`
varying vec2 vLocal;
varying vec3 vTint;
varying float vAmt;
void main() {
	float d = length( vLocal ) * 2.0;
	if ( d >= 1.0 ) discard;
	float f = 1.0 - d;
	float a = pow( f, 1.6 ) * ( 0.28 + 0.72 * f );  // broad soft pool, hot centre
	gl_FragColor = vec4( vTint * ( a * vAmt ), 1.0 );
}
`;

const GLOW_VERT = /* glsl */`
attribute vec3 aTint;
attribute vec3 aParam;      // x radius, y intensity, z phase
varying vec2 vLocal;
varying vec3 vTint;
varying float vAmt;
uniform float uNight;
uniform float uTime;
void main() {
	vLocal = position.xy;
	float flicker = 0.92 + 0.08 * sin( uTime * ( 1.7 + aParam.z * 2.6 ) + aParam.z * 17.0 );
	vTint = aTint;
	vAmt = aParam.y * uNight * flicker;
	vec4 centre = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
	centre.xy += position.xy * aParam.x * 2.0;    // camera-facing billboard
	gl_Position = projectionMatrix * centre;
}
`;

const GLOW_FRAG = /* glsl */`
varying vec2 vLocal;
varying vec3 vTint;
varying float vAmt;
void main() {
	float d = length( vLocal ) * 2.0;
	if ( d >= 1.0 ) discard;
	float f = 1.0 - d;
	float a = pow( f, 2.2 ) * 0.75 + pow( f, 12.0 ) * 0.9;
	gl_FragColor = vec4( vTint * ( a * vAmt ), 1.0 );
}
`;

// ---------------------------------------------------------------------------
// Colour grading table for the celestial rig.
// nightT: 0 = noon .. 0.5 = horizon .. 1 = midnight.
// ---------------------------------------------------------------------------

function srgb(hex) { return new THREE.Color().setHex(hex, THREE.SRGBColorSpace); }

// Intensities are tuned for an energy-conserving BRDF (the diffuse lobe divides
// by PI) with NO tone mapping, so the shaded result lands bright and saturated
// straight out of the rig. Roughly 60 % direct / 40 % coloured fill at noon:
// shadowed areas stay vivid instead of going grey, the Cities: Skylines read.
const GRADE = [
  // t,   sun colour, sun intensity, sky (hemi up), ground (hemi bounce), ambient, ambient int, hemi int
  { t: 0.00, sun: 0xfff3dd, si: 2.35, sky: 0xcfe9ff, gnd: 0x9fd07a, amb: 0xbcd8ff, ai: 0.50, hi: 1.00 },
  { t: 0.28, sun: 0xfff0c8, si: 2.26, sky: 0xc9e6ff, gnd: 0xa2d07c, amb: 0xc2dcff, ai: 0.50, hi: 1.00 },
  { t: 0.40, sun: 0xffd79a, si: 2.18, sky: 0xd8e2ff, gnd: 0xb6c884, amb: 0xd6d2ff, ai: 0.48, hi: 0.86 },
  { t: 0.48, sun: 0xffb069, si: 2.24, sky: 0xffd7c0, gnd: 0xcda882, amb: 0xffcfae, ai: 0.44, hi: 0.70 },
  { t: 0.53, sun: 0xff8a4d, si: 1.72, sky: 0xffb69b, gnd: 0xa88b8c, amb: 0xffb99c, ai: 0.42, hi: 0.60 },
  { t: 0.62, sun: 0xd6707f, si: 0.78, sky: 0xa88fc8, gnd: 0x6a6a92, amb: 0xc0a8dd, ai: 0.48, hi: 0.62 },
  { t: 0.78, sun: 0x7f8fd0, si: 0.46, sky: 0x6377b8, gnd: 0x454e80, amb: 0x8ea2dd, ai: 0.56, hi: 0.70 },
  { t: 1.00, sun: 0x9fb4ee, si: 0.44, sky: 0x53669f, gnd: 0x3c4672, amb: 0x8fa6e2, ai: 0.58, hi: 0.72 },
];

const GRADE_C = GRADE.map((g) => ({
  t: g.t, sun: srgb(g.sun), si: g.si, sky: srgb(g.sky), gnd: srgb(g.gnd),
  amb: srgb(g.amb), ai: g.ai, hi: g.hi,
}));

// ---------------------------------------------------------------------------

// `rotate` is the kernel-rotation BLOCK SIZE in device pixels, not a 0/1 flag
// (see csmApply). 0 = off, 1 = per pixel (the confetti generator), N = one
// rotation per NxN screen block.
//
// Measured rooftop-penumbra hf1 on the street shot at quality 2 (baseline with
// shadows off: 0.32) — rotation is the whole difference between "fizzing" and
// "clean", and once the taps are bilinear a fixed kernel wins outright:
//   per-pixel (the old code, 16 nearest taps) 2.25
//   block 4                                   1.29
//   block 8                                   1.16
//   block 16                                  1.04
//   none                                      1.00
// Quality 1 keeps a block rotation because 5 taps show the fixed disk more.
//
// isoTile / isoGrid: the ISO LAYOUT (orthographic game camera, round 4). An
// ortho camera has no perspective foreshortening, so depth-split cascades are
// pointless there: every cascade had to cover the whole screen width, and at
// iso-close a 1024 tile gave 0.064-0.134 world units per shadow texel = 4-9
// device pixels per texel, which is what the r3 critic saw as "smeared,
// streaky, dithered grey blotches with ragged edges". In the iso layout
// cascade 0 is a tight light-space RECTANGLE fitted to what is on screen at an
// isoTile^2 resolution, cascade 1 a coarse whole-view fallback (anything taller
// than the fit), and the filter is an exact separable tent over an isoGrid-
// texel window (see csmGridFilter) instead of a sparse Vogel disk.
const QUALITY = [
  { cascades: 1, taps: 4,  search: 4,  tile: 1024, rotate: 0, bilinear: 0, farScale: 0.75, aoRes: 0,    aoTaps: 0,  isoTile: 1536, isoGrid: 2 },
  { cascades: 2, taps: 5,  search: 6,  tile: 1024, rotate: 4, bilinear: 1, farScale: 0.9,  aoRes: 1024, aoTaps: 8,  isoTile: 2048, isoGrid: 2 },
  { cascades: 3, taps: 8,  search: 8,  tile: 1024, rotate: 0, bilinear: 1, farScale: 1.0,  aoRes: 2048, aoTaps: 12, isoTile: 2048, isoGrid: 3 },
];

// ---------------------------------------------------------------------------
// World-AO height volume pass (see "WORLD-SPACE AMBIENT OCCLUSION" in the GLSL).
// One top-down orthographic pass, MAX-blended, no depth test: every fragment
// writes its world height (+20 so "nothing" clears to 0) into R, and — only if
// it faces DOWN (a back face seen from above) — into G as well. MAX blending
// then leaves R = the column's highest surface and G = its lowest underside.
// ---------------------------------------------------------------------------
const AO_VERT = /* glsl */`
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
varying float vAoY;
void main() {
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	vec4 aoW = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
	aoW = batchingMatrix * aoW;
	#endif
	#ifdef USE_INSTANCING
	aoW = instanceMatrix * aoW;
	#endif
	vAoY = ( modelMatrix * aoW ).y;
}
`;

const AO_FRAG = /* glsl */`
varying float vAoY;
void main() {
	float h = max( vAoY + 20.0, 0.0 );
	// G (r7b): the LOWEST down-facing surface — the first ceiling above the
	// floor — stored as 1 / (h + 1) so the MAX blend keeps the minimum;
	// AO_COPY_FRAG decodes it back to h. (Was the highest underside: under a
	// stepped cornice that picked the top tier, and the lower tier then hid
	// the pavement from the floor pass.)
	gl_FragColor = vec4( h, gl_FrontFacing ? 0.0 : 1.0 / ( h + 1.0 ), 0.0, 0.0 );
}
`;

// Second scene pass (light r7b): the column's FLOOR — the highest up-facing
// surface strictly below its lowest underside (tSrc = the first pass). MAX
// blended into A of a copy of the first pass. That is the paving under an
// awning, a cornice lip or an umbrella: the surface the wall-foot / prop-foot
// contact line has to land on (the first pass only knew the overhang's top).
// A floor can also be BURIED (terrain under a lot slab, paving under a wall:
// catalog meshes are open underneath); AO_FLOOD_FRAG only accepts a floor
// that connects sideways, at or above floor level, to open ground.
const AO_FLOOR_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying float vAoY;
void main() {
	float h = max( vAoY + 20.0, 0.0 );
	float g = texture2D( tSrc, gl_FragCoord.xy * uTexel ).g;
	float U = g > 0.0 ? 1.0 / g - 1.0 : 0.0;
	gl_FragColor = vec4( 0.0, 0.0, 0.0, ( gl_FrontFacing && h < U - 0.02 ) ? h : 0.0 );
}
`;
const AO_COPY_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
void main() {
	vec4 c = texture2D( tSrc, gl_FragCoord.xy * uTexel );
	gl_FragColor = vec4( c.r, c.g > 0.0 ? 1.0 / c.g - 1.0 : 0.0, c.b, c.a );   // decode G (AO_FRAG)
}
`;

// "Is the space under this underside actually OPEN AIR?" Voxel buildings are
// hollow shells (core.js walls()), so the roof slab of every building has a
// down-facing underside too — seen from above, a hollow tower and a cornice
// look identical (a slab over empty space). Measured on the demo city: the
// tallest building near the target read top 16.66 / underside 16.41, i.e. a
// floating 0.25-unit slab, and nothing at its foot was occluded at all.
// The difference is lateral: the space under a cornice, sill, balcony, awning
// or canopy connects sideways to open air; a building's interior is walled in
// (wall columns have no underside, so they block). A few ping-pong passes flood
// "exposed" in from open columns through underside columns only — a bounded
// flood fill, ~aoFloodWorld units deep. Encoding of G after the flood:
//   > 0  exposed underside (height + 20)     = 0  no underside
//   < 0  enclosed underside (-(height + 20)) -> treated as solid to the ground
const AO_QUAD_VERT = /* glsl */`
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;
const AO_FLOOD_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uInit;
vec4 aoN( const in vec2 uv ) { return texture2D( tSrc, uv ); }
float aoExposes( const in vec4 v, const in float U ) {
	if ( v.g > 0.5 ) return 1.0;                                   // exposed under-space
	if ( abs( v.g ) < 0.5 && v.r < U - 0.05 ) return 1.0;          // open column lower than our underside
	return 0.0;
}
// Floor validity (A > 0 valid, A < 0 not yet): our floor F is real open floor
// if a neighbour's walkable level (an open column's top, or a valid floor) is
// no higher than F + tol — i.e. F is not buried under that neighbour's slab.
float aoFloorOk( const in vec4 v, const in float U, const in float F ) {
	float lvl = - 1.0;
	if ( abs( v.g ) < 0.5 && v.r > 0.0 && v.r < U - 0.05 ) lvl = v.r;
	else if ( v.a > 0.5 ) lvl = v.a;
	return ( lvl > 0.0 && F >= lvl - 0.05 ) ? 1.0 : 0.0;
}
void main() {
	vec2 uv = gl_FragCoord.xy * uTexel;
	vec4 c = aoN( uv );
	if ( uInit > 0.5 ) { gl_FragColor = vec4( c.r, c.g > 0.5 ? - c.g : 0.0, 1.0, c.a > 0.5 ? - c.a : 0.0 ); return; }
	vec4 o = vec4( c.rg, 1.0, c.a );
	float U = abs( c.g );
	vec4 n0 = aoN( uv + vec2( uTexel.x, 0.0 ) ), n1 = aoN( uv - vec2( uTexel.x, 0.0 ) );
	vec4 n2 = aoN( uv + vec2( 0.0, uTexel.y ) ), n3 = aoN( uv - vec2( 0.0, uTexel.y ) );
	if ( c.g < 0.0 ) {
		float ex = max( max( aoExposes( n0, U ), aoExposes( n1, U ) ), max( aoExposes( n2, U ), aoExposes( n3, U ) ) );
		o.g = ex > 0.5 ? U : - U;
	}
	if ( c.a < - 0.5 ) {
		float F = - c.a;
		float ok = max( max( aoFloorOk( n0, U, F ), aoFloorOk( n1, U, F ) ), max( aoFloorOk( n2, U, F ), aoFloorOk( n3, U, F ) ) );
		o.a = ok > 0.5 ? F : - F;
	}
	gl_FragColor = o;
}
`;

// Ground AO, solved once per height-volume refresh in map space (see the
// round-7 note above csmWorldAO). For every column, the receiver is its top;
// 16 fixed directions x 8 steps (denser near the receiver) inside uP.x world
// units; per direction the max horizon sine, weighted by (1 - (r/R)^2) so
// the darkening is tight at the contact and gone by R. Deterministic (no
// noise to denoise); AO_BLUR_FRAG smooths what the step spacing leaves.
// Column helpers shared by the map-space passes (all heights in +20 units).
// A holds the column's validated floor (AO_FLOOR_FRAG + AO_FLOOD_FRAG).
// An 'overhang column' (exposed underside with a floor under it: awning,
// cornice lip, umbrella, canopy) receives its AO at the FLOOR, and shows a
// neighbour only its floor while the neighbour stands below the overhang —
// so the paving under an awning gets its wall-foot line, and a cornice does
// not read as a 9-unit wall to the pavement beside it.
const AO_COLUMN_GLSL = /* glsl */`
float aoFloor20( const in vec4 t ) { return max( t.a, 0.0 ); }
float aoIsOver( const in vec4 t ) {
	return ( t.g > 0.5 && t.a > 0.5 && t.a < t.g - 0.05 ) ? 1.0 : 0.0;
}
float aoRecv( const in vec4 t ) { return aoIsOver( t ) > 0.5 ? aoFloor20( t ) : t.r; }
float aoOccH( const in vec4 t, const in float y ) {
	return ( aoIsOver( t ) > 0.5 && t.g > y + 0.05 ) ? aoFloor20( t ) : t.r;
}
`;

const AO_GROUND_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform vec4 uP;                 // x radius (world), y world units per texel, z steps, w tight share
uniform vec4 uP2;                // x broad radius (world), y broad strength
${AO_COLUMN_GLSL}
void main() {
	vec2 uv = gl_FragCoord.xy * uTexel;
	vec4 c = texture2D( tSrc, uv );
	if ( c.r <= 0.0 ) { gl_FragColor = vec4( c.rg, 1.0, c.a ); return; }
	float R = uP.x;
	float y0 = aoRecv( c );
	float occ = 0.0, occT = 0.0;
	for ( int d = 0; d < 16; d ++ ) {
		float a = ( float( d ) + 0.5 ) * 0.39269908;
		vec2 dir = vec2( cos( a ), sin( a ) ) * uTexel / uP.y;
		float hm = 0.0, ht = 0.0;
		for ( int s = 0; s < 8; s ++ ) {
			if ( float( s ) >= uP.z ) break;
			float t = ( float( s ) + 1.0 ) / uP.z;
			float r = max( R * pow( t, 1.5 ), 0.9 * uP.y );
			float h = aoOccH( texture2D( tSrc, uv + dir * r ), y0 ) - y0;
			float q = r / R;
			float sn = h / sqrt( h * h + r * r );
			hm = max( hm, sn * ( 1.0 - q * q ) );
			// tight contact term: only what stands within ~0.3 R (the crease line)
			float qt = min( r / ( 0.3 * R ), 1.0 );
			ht = max( ht, sn * ( 1.0 - qt * qt ) );
		}
		occ += hm; occT += ht;
	}
	float v = ( 1.0 - occ / 16.0 ) * ( 1.0 - uP.w * occT / 16.0 );
	// Broad term (r7b; critic r6: "large flat areas get almost no light
	// variation"): a sparse 8 x 4 horizon search out to uP2.x, so plazas,
	// pool decks and lawns darken gently toward the buildings around them
	// the way ref05's GI does. Tops only: a far-away tower barely registers.
	if ( uP2.y > 0.0 ) {
		float ob = 0.0;
		for ( int d = 0; d < 8; d ++ ) {
			float a = ( float( d ) + 0.25 ) * 0.78539816;
			vec2 dir = vec2( cos( a ), sin( a ) ) * uTexel / uP.y;
			float hm = 0.0;
			for ( int s = 1; s <= 4; s ++ ) {
				float r = uP2.x * float( s ) * 0.25;
				float h = aoOccH( texture2D( tSrc, uv + dir * r ), y0 ) - y0;
				float q = r / uP2.x;
				hm = max( hm, h / sqrt( h * h + r * r ) * ( 1.0 - q * q ) );
			}
			ob += hm;
		}
		v *= 1.0 - uP2.y * ob / 8.0;
	}
	gl_FragColor = vec4( c.rg, clamp( v, 0.0, 1.0 ), c.a );
}
`;

// Height-aware separable blur of the B channel (binomial 1-4-6-4-1): only
// columns whose top is within ~0.15 units mix, so a roof's value never bleeds
// onto the ground at its foot (that would lift the contact line) and vice
// versa. R/G pass through untouched.
const AO_BLUR_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform vec2 uDir;
${AO_COLUMN_GLSL}
void main() {
	vec2 uv = gl_FragCoord.xy * uTexel;
	vec4 c = texture2D( tSrc, uv );
	float y0 = aoRecv( c );
	float acc = c.b * 6.0, wsum = 6.0;
	for ( int i = - 2; i <= 2; i ++ ) {
		if ( i == 0 ) continue;
		vec4 t = texture2D( tSrc, uv + uDir * uTexel * float( i ) );
		float w = ( abs( float( i ) ) > 1.5 ? 1.0 : 4.0 ) * ( 1.0 - smoothstep( 0.08, 0.2, abs( aoRecv( t ) - y0 ) ) );
		acc += t.b * w; wsum += w;
	}
	gl_FragColor = vec4( c.rg, acc / wsum, c.a );
}
`;

/**
 * LightingRig — sun/moon + ambient + CSM + night light pools.
 * See CONTRACTS-RENDER.md §3.8 for the full API.
 */
export class LightingRig {

  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.opts = Object.assign({
      quality: 2,
      cascades: null,            // null => follow quality
      shadowTile: null,          // null => follow quality
      sunSource: 'internal',     // 'internal' | 'external'
      mapCenter: new THREE.Vector3(320, 0, 320),
      mapSize: 640,
      maxCasterHeight: 56,
      shadowDistance: null,      // null => derived from ctx.camDist
      // The slab fit below is tight, but at the hero framing it landed at ~288
      // view units while the visible city runs out past 400 — so the back half
      // of every screenshot had no shadows at all. Floor the fit well past the
      // horizon of a typical shot; the cascade split scheme keeps the near
      // cascade tight anyway, so this costs resolution only in cascade 2.
      minShadowDistance: 460,
      maxShadowDistance: 1000,
      splitLambda: 0.86,
      normalOffsetTexels: 2.0,   // was 1.0 — res-4 detail is thin along the light ray (acne); coordinator 12:25
      depthBiasTexels: 2.5,      // was 0.5 — see pieces/light.md 12:25 note
      // Penumbra. NOTE the interaction with `casterSide: BackSide`: the atlas
      // stores SECOND depth, i.e. where the light ray LEAVES the caster, so the
      // PCSS blocker distance is overestimated by roughly the caster's
      // thickness along the ray. A 30-voxel tower therefore reports a ~60-unit
      // gap and pins the penumbra at its maximum, which is why a generous
      // maxPenumbra turned every building shadow into a vague grey cloud
      // instead of a shape. Keep the ramp shallow and the cap tight: contact
      // hardening still works (a lamp post 4 units up gets ~0.15 units of
      // penumbra) but nothing ever blurs past a voxel and a half.
      softness: 0.030,           // penumbra world units per world unit of gap
      // NOTE minPenumbra is a WORLD-space floor and is therefore not the one
      // that keeps the shadow edge above the framebuffer's sampling limit — see
      // penumbraFloorPixels below, which is.
      minPenumbra: 0.08,
      maxPenumbra: 1.50,
      blockerSearchWorld: 1.6,
      shadowStrength: 0.97,      // 1 = physical; <1 keeps shadows colourful
      // Directional wall fill (light r8, csmWallFill): daytime share of the
      // fill (hemi + ambient + diffuse IBL) that walls turned AWAY from the
      // key lose, the extra share key-facing walls gain, and the away walls'
      // hue (linear, luminance ~1: a touch cool, they see open blue sky).
      // Scaled per frame by setWallFillAmount() (engine: sky artAmount).
      // Measured iso-mid (normal-masked faces, sRGB luma right/left): neutral
      // walls 0.88 -> 0.81, blue 0.77 -> 0.64, green 0.84 -> 0.72 against
      // this off; white prop 1 : 0.91 : 0.64. Post's shaded-face floor lifts
      // the far walls back up — with it at 0.12 instead of 0.24 the same
      // light gives neutral 0.70 / blue 0.57 (see pieces/light.md r8).
      // w4r2 (critic w4r1: downtown right faces "only slightly darker" than
      // left): 0.75 -> 0.95, plus wallFillSpec = share of the same cut on the
      // sky SPECULAR (glass / glossy trim mirrored the same bright sky on both
      // walls). Corner right/left at iso-mid 0.654 -> 0.598 with the w4r2 key.
      // w4r3 (critic w4r2: right faces / canyons now read "heavy"; w4r1 had
      // asked for deeper) -> the midpoint: 0.95 -> 0.80. Corner right/left at
      // iso-mid 0.561 -> ~0.61 (w4r1 saw 0.654, w4r2 0.561; ref05 ~0.57),
      // faceratio 1 : 0.89 : 0.59 -> 1 : 0.89 : ~0.625 (ref04 0.63).
      // w4r4 (critic w4r3: right faces / canyons "dim, desaturated navy-grey";
      // wants them cooler and airier, not darker): the warm sun bounce on far
      // walls is halved (engine DAY_BOUNCE_SCALE 0.08 -> 0.04) and replaced
      // by more of this COOL fill: 0.80 -> 0.68, tint [0.88,0.98,1.16] ->
      // [0.80,0.97,1.36]. faceratio stays 1 : 0.89 : 0.63 but the white
      // probe's right face goes (154,155,150) -> (149,156,162): sky-tinted.
      wallFillAway: 0.68,
      wallFillToward: 0.25,
      wallFillTint: [0.80, 0.97, 1.36],
      wallFillSpec: 0.6,
      // w4r2: hue of the fill left inside a cast shadow on up-facing surfaces
      // (csmWallFill). ref05's shadows on warm tan plinths measure B/R ~1.03
      // (blue-grey) against ~0.7 lit; ours were 0.88 (olive). This tint takes
      // light paving in shadow to B/R 1.03 at the same luminance ratio (0.59).
      shadowFillTint: [0.76, 0.96, 1.45],
      shadowFillTintAmount: 1.0,
      // How much of each INDIRECT term a SKY-OCCLUDED fragment loses. These are
      // multiplied by csmSkyOcclusion(), NOT by the cast-shadow term — see the
      // long note above csmSkyOcclusion(). Driving them off the cast shadow (at
      // 0.72 / 0.55) is what crushed shadowed ground to luma 5 against 74 lit.
      // Caps this size, gated by contact proximity, put a street canyon
      // meaningfully darker than open shadowed ground while keeping the whole
      // shadow inside a 3-4:1 sRGB budget of the lit surface next to it.
      //
      // The numbers below are the MAXIMUM (fully enclosed / contact) occlusion;
      // csmSkyOcclusion() scales them down to `skyOpenFloor` of that for open
      // ground. What OPEN shadowed ground actually loses is the product:
      //   sky IBL      0.88 x 0.30 = 0.26
      //   hemi/ambient 0.64 x 0.30 = 0.19
      // i.e. the ~0.25 / ~0.20 the art direction asked for. The caps look large
      // only because a fragment genuinely tucked against a caster SHOULD go
      // that dark; the old code applied its cap everywhere, which is what
      // crushed open ground.
      //
      // Measured back-to-back in ONE session (the rest of src/render/ is being
      // re-graded by other agents continuously, so numbers taken half an hour
      // apart are not comparable — SM.legacy() / SM.ab() in
      // tools/rendertest/shadowmeter.js flip the rig between the two behaviours
      // live). Reference city, seed 20240601, quality 2. lit:shadow sRGB luma
      // medians, road / terrain:
      //
      //   config                                street       golden       hero
      //   OLD (0.72/0.55 off the CAST SHADOW)   7.63 / 4.88  4.19 / 3.32  4.04 / 3.21
      //   THESE with the gate off (floor = 1)  10.18 / 5.89       -            -
      //   THESE                                 4.76 / 3.83  3.02 / 2.60  3.12 / 2.64
      //
      // and the gate lifts the CRUSHED end specifically: same shot, gate off vs
      // on, shadowed road p10 6.9 -> 15.1 while p90 barely moves (49.0 -> 54.9).
      shadowAmbient: 0.64,       // hemisphere + ambient + light probes
      shadowIbl: 0.88,           // diffuse sky IBL (envMap)
      shadowSpecular: 0.46,      // specular sky reflection (kept gentle: glass keeps life)
      shadowContrast: 0.55,      // 0..1 S-curve on the penumbra ramp: shape, not haze
      // Sky-visibility model (defect 1). `skyContactWorld` is the 2-folding
      // distance of the contact term in world units: at `gap` = this value the
      // fragment counts as half-enclosed. `skyOpenFloor` is how much sky an
      // open, merely sun-blocked fragment still loses.
      skyContactWorld: 10.0,
      skyOpenFloor: 0.30,
      // Resolution-aware filter floor, in DEVICE pixels of penumbra radius.
      // Every other width in this block is in world units, which is why the
      // stipple fix only held at the camera distance it was tuned at: a
      // 0.08-world-unit minimum penumbra is 4 device pixels at the street shot,
      // 1.5 at hero and 0.6 at region, i.e. the shadow edge falls through the
      // framebuffer's Nyquist limit as you zoom out and starts aliasing. This
      // floors the PCF footprint at a fixed number of PIXELS instead, so the
      // edge keeps the same on-screen softness at every zoom and at every
      // device pixel ratio. 0 restores the old distance-dependent behaviour.
      // Measured sweep at 2880x1800, rooftop hf1 excess over a shadows-OFF
      // clean plate on the same pixels, hero / region:
      //   0 (off) 1.020 / 0.421     3 px 0.760 / 0.320
      //   4 px    0.718 / 0.306     5 px 0.659 / 0.280
      // Past ~4 px the curve flattens and the lit:shadow ratio starts paying
      // for it (road 2.74 -> 2.68 by 5 px), so 4 is the knee. It is a RADIUS,
      // so the edge it guarantees is ~8 device pixels wide — 4 CSS pixels at
      // the 2x ratio this game usually runs at.
      penumbraFloorPixels: 4.0,
      // Taps per texel^2 of PCF disk area. The tap budget in QUALITY[] is the
      // MINIMUM; this adds taps only where the resolution floor above has
      // actually widened the kernel, keeping the tap spacing near one texel so
      // the wider disk is genuinely filtered instead of sparsely poked. 0 =
      // fixed tap count (the pre-fix behaviour).
      tapDensity: 1.6,
      // Bilinear (sampler2DShadow-style) tap filtering. See csmTap(): it is
      // what turns the 16-step stair of a nearest-sampled packed-depth atlas
      // into a continuous penumbra. Quality 1/2 halve their tap budget to pay
      // for it; quality 0 leaves it off.
      bilinearTaps: true,
      // ---- world-space AO (the "anchoring darkness", see the GLSL notes) ----
      // aoRadius: reach of the kernel in world units (a res-4 voxel is 0.25).
      // ref04's gradient under a cornice / at a wall foot runs ~6-10 voxels.
      // aoIndirect: how much of the hemi/ambient/sky-IBL fill an enclosed
      // point loses (multi-bounce keeps it coloured). aoDirect: artistic share
      // of the key so a SUNLIT wall still darkens at its foot and under ledges.
      // aoFillSaturation: bounce colour carried by the fill (dark sides stay
      // a rich darker version of the wall colour, never grey).
      // r7: the sparse-kernel version (blocky ghosts, switched off 13:10) is
      // gone; this is the map-space contact AO (see the GLSL note above
      // csmWorldAO). aoRadius: reach of the ground horizon search (a res-4
      // voxel is 0.25). aoContact: height over which a wall's foot line fades.
      // aoGradHeight/Depth: broad wall gradient (lighter toward the top).
      // aoCover: sky vis of ground under a low overhang (awning, umbrella).
      // aoCrease/Dist: dark band on a wall under an exposed underside
      // (cornice, sill, awning). aoGap: vis of a wall facing solid stuff
      // closer than ~1 texel (narrow slots). aoHeightTol: same-surface test.
      worldAO: true,
      aoRadius: 1.0,
      // r7b: extra darkening from what stands within 0.3 aoRadius only — the
      // thin crease line at a wall foot / prop foot (critic r6: "no tight dark
      // AO line where the walls meet the plinth"). 0 = off.
      aoTight: 1.0,
      // r7b: broad ground term (see AO_GROUND_FRAG): strength / reach (world).
      aoBroad: 0.25,
      aoBroadRadius: 4.0,
      aoIndirect: 1.0,
      aoDirect: 0.60,            // w4r4: 0.85 -> 0.60 (see aoGap)
      aoContact: 0.45,
      aoGradHeight: 5.0,
      aoGradDepth: 0.25,
      // r7b: whole-wall fill gradient, foot -> top of the solid (see csmWorldAO).
      aoWallGrad: 0.15,          // w4r4: 0.3 -> 0.15 (see aoGap)
      aoWallGradPow: 0.8,
      // r9: smooth floor on the INDIRECT world-AO visibility (see csmAoIndirect):
      // crevices keep at least this share of their fill; knee = blend width.
      aoFillFloor: 0.45,         // w4r4: 0 -> 0.45 (no near-black crevices; see aoGap)
      aoFillKnee: 0.15,
      aoCover: 0.55,
      aoCrease: 0.5,
      aoCreaseDist: 0.35,
      // w4r4 (critic w4r2 + w4r3: tower canyons read heavy / murky navy):
      // A/B at iso-mid showed world AO taking downtown key-side walls from
      // 165 to 146 sRGB luma and roofs 148 -> 135, mostly as grey bands over
      // every recessed window column (the narrow-gap term fires on the
      // pilasters beside each pane, then aoPower squares it) plus the wall
      // gradient and the direct-key share. aoGap 0.5 -> 0.85, aoWallGrad
      // 0.3 -> 0.15, aoDirect 0.85 -> 0.6, aoFillFloor 0 -> 0.45: walls
      // 161 -> 178, roofs p25 104 -> 114, frame p25 66 -> 75; the wall-foot /
      // prop-foot contact line (ground term + aoTight) is untouched.
      aoGap: 0.85,
      aoHeightTol: 0.06,
      aoFillSaturation: 0.50,    // w4r4: 0.30 -> 0.50 (the cooler far-wall fill keeps warm walls' hue)
      aoFloodWorld: 1.6,         // how deep "open air" reaches under an overhang
      aoPower: 2.0,              // contrast of the visibility curve (>1 = deeper tuck)
      moonShadows: true,
      moonShadowStrength: 0.55,  // cascade strength multiplier while the moon keys
      maxSunElevation: 62,       // degrees
      horizonEase: 0.62,         // <1 = linger longer in the golden-hour band
      // Below `minShadowElevation` the SHADOW DIRECTION is lifted so the ortho
      // frustum stays sane; `shadowFadeLo/Hi` is the separate strength ramp.
      // These used to be 4.5 / smoothstep(1, 9) degrees, which auto-faded a
      // 6.4-degree sun to strength 0.731 — golden hour is exactly when shadows
      // should be longest and most dramatic, so full strength now persists all
      // the way down to ~3 degrees and only the last sliver above the horizon
      // fades out.
      minShadowElevation: 2.0,   // degrees; the direction clamp only
      shadowFadeLo: 0.4,         // degrees; strength 0 at/below this
      shadowFadeHi: 3.0,         // degrees; FULL strength at/above this
      azimuthBase: 0.55,         // radians
      azimuthSweep: 1.15,        // radians swept across the day

      // ---- moon key (see _updateCelestial) ----------------------------------
      // In 'external' mode sky.js hands us `keyDir`, which is the sun by day and
      // the MOON by night — so `sunDir.y < 0` can never detect the moon (the
      // moon is ABOVE the horizon; that is the whole point of it). `moonAfter`
      // is the nightT band over which the key changes body; it mirrors sky.js's
      // own `smoothstep((t - 0.36) / 0.20)` moonrise and the moment its sun
      // crosses the horizon (t = 0.5).
      moonAfterLo: 0.50,
      moonAfterHi: 0.58,
      // A key at 4.3 degrees delivers sin(4.3) = 0.075 of itself to a road or a
      // roof — i.e. nothing. Real moonlight is a re-lit sun and rides a real
      // arc. This is a FLOOR on the moon key's elevation, applied to the light
      // AND to the cascade direction so shading and shadows agree. It is a
      // no-op the moment sky.js's own moon arc reaches it, which is the proper
      // fix (the visible DISC is sky.js's; see the note in _updateCelestial).
      // null disables the floor entirely.
      moonKeyElevation: 30,      // degrees
      lampColor: 0xffc47c,   // night r1: a touch warmer than 0xffcf8a (sodium-ish, still cheerful)
      // coherence 09-25: 9.5 / 1.0 were tuned for the old perspective camera
      // and sparse lamps. With the iso camera and ~1 lamp per road tile the
      // additive pools overlapped into solid orange roads (markings, zebras
      // and asphalt all gone) — measured the whole night street grid as sand.
      // Small, dim pools keep the warm puddles and leave the roads readable.
      // night r1: 5.0 / 0.10 left a faint, wide orange smear whose dim fringe
      // sat right on post.js's asphalt gates (sparkle). A smaller, brighter
      // pool reads as a lamp's own puddle of light and still leaves the
      // asphalt, markings and zebras between lamps (coherence #1 kept).
      // w4r3 (critic w4r2: "lamp pools are small dim dots, not pools on the
      // asphalt"): 3.4 / 0.24 -> 4.4 / 0.34.
      lampRadius: 4.4,
      lampIntensity: 0.34,
      // night w4r6: per-lamp variation (see _fillInstances): radius +/-, intensity +/-, warm-white share.
      lampVary: [0.28, 0.35, 0.3],
      // night r1: the bulb billboard was a 3-unit disc (glowRadius 1.5) on a
      // 2.3-unit lamp — a floating orange ball bigger than the post. A small
      // hot core; bloom supplies the halo.
      lampGlowRadius: 0.55,
      lampGlowIntensity: 1.1,
      // night r1: camera-facing window-spill billboards clip against the
      // facades they sit in and printed pale "wedges" / warm haze sheets over
      // whole blocks (coherence #2, surface r5 notes). The lit panes carry the
      // read on their own; the list is still accepted (and still feeds the
      // sky's city glow via engine.js), it is just not drawn.
      windowGlowBillboards: false,
      // Casters render their BACK faces. Blockville's casters are closed voxel
      // shells, so the stored depth is a whole object-thickness behind the lit
      // surface and self-shadow acne simply cannot occur — which is what lets
      // the bias stay at ~1 texel instead of the ~1 world unit the old rig
      // needed. Switch to FrontSide only if you add open/single-sided casters
      // (they cast nothing under BackSide), and raise the two bias texel
      // counts to ~3.0 / ~1.5 if you do.
      //
      // Round 3: that premise no longer holds. The res-4 catalog meshes are
      // OPEN underneath (no bottom faces under lots, canopies or buildings —
      // they are never seen from the iso camera), so a light ray entering a
      // roof or canopy top leaves through a face that does not exist and
      // BackSide stores nothing: whole buildings cast only thin slivers from
      // their far walls, and tree shadows broke into jagged fragments
      // detached from the trees. That was the r2 critic's "buildings cast
      // almost no visible shadow onto the road, the lots or the blocks next to
      // them". DoubleSide stores the NEAREST surface of every caster, closed
      // or not; the acne that invites is held off by the bias the coordinator
      // already raised for res-4 detail (2.5 / 2.0 texels, above).
      casterSide: THREE.DoubleSide,
      rotateBlock: null,         // null => follow quality (see QUALITY[].rotate)
      farCascadeInterval: 2,     // far cascades re-render every N frames if stable
      cacheStatic: true,         // PERF: skip cascade redraws while nothing changed (see _casterSig)
      staticRefresh: 120,        // ...but redraw at least every N frames anyway
      lowRateRefresh: 4,         // ...or every N frames while an animated caster (userData.shadowLowRate) is visible
      // ---- iso layout (orthographic camera; see QUALITY) ----------------------
      isoLayout: true,
      isoTile: null,             // null => QUALITY[].isoTile
      isoGrid: null,             // null => QUALITY[].isoGrid (tent window half-width, texels)
      isoFitLow: -2,             // receiver slab the tight cascade must cover (world y)
      isoFitHeight: 24,
      isoFitStep: 2,             // extent quantum (world units): texel size only changes in steps
      isoFitMargin: 1.5,
      envIntensity: 1.0,
      exposure: 1.0,             // scales sun + fill together (post.js may want <1)
      fillBoost: 1.0,            // scales ONLY the ambient/hemi fill: >1 = softer shadows

      // ---- low-sun skylight re-grade ("golden hour is measurably blue") -----
      // Skylight is not a constant. When the sun is high the dome that fills the
      // shadows is a blue zenith; when it is low, the zenith stops being fed and
      // the dome a horizontal surface integrates is dominated by the warm
      // horizon band. The rig used to hold hemisphere + ambient at daylight blue
      // all the way down to the horizon, so at 19.9 degrees of sun elevation —
      // sun colour #ffb95a, 2.83:1 warm — measured LIT road/terrain/building
      // came back at R/B 0.70/0.69/0.70, i.e. 42 % BLUER than neutral. Cold blue
      // dusk with the office lights on, not golden hour.
      //
      // `skylightWarmth` ramps in over the elevation band below and re-grades
      // three things at once (all of them skylight, none of them the key):
      //   1. hemisphere sky + ground colour,
      //   2. ambient colour,
      //   3. the DIFFUSE sky IBL, via the uCsmIblTint uniform.
      // Intensities drop as well, because low-sun skylight really is weaker.
      // The colour rotation is close to LUMINANCE PRESERVING by construction
      // (see _skylightGrade), which is what keeps the verified lit:shadow ratios
      // where they are while the hue swings.
      // Measured sweep at the `golden` shot (19.94 deg sun, #ffb95a key), LIT
      // road / terrain / building R/B, with the lit:shadow luma ratio beside it
      // — the ratio is what the re-grade is not allowed to move:
      //
      //   warmth 0 (the defect)            0.69 / 0.65 / 0.61   1.74 / 1.83
      //   band 15-32, horizon ffa869       1.14 / 0.94 / 0.99   1.75 / 1.86
      //   band 18-34, horizon ffa869       1.24 / 1.00 / 1.08   1.76 / 1.87
      //   band 18-34, horizon ff9f55       1.27 / 0.98 / 1.07   1.98 / 2.03
      //   band 18-34, horizon ff8f3f       1.38 / 1.04 / 1.16   1.99 / 2.04  <-
      //   band 18-34, horizon ff8630       1.42 / 1.06 / 1.19   2.00 / 2.06
      //
      // (the two ratio columns shifted between sessions because another agent
      // was re-tuning the PCF footprint in this same file at the time; every
      // row inside one block was measured back to back against its own control)
      //
      // The band is 18-34 rather than something centred lower because the
      // re-grade has to be most of the way IN at 20 degrees (that is where the
      // game lingers — see `horizonEase`) while leaving the 27-degree afternoon
      // shot only lightly touched (measured warm 0.41 there) and anything above
      // 34 degrees bit-identical.
      skylightWarmth: 1.0,       // master 0..1; 0 restores the old flat blue fill
      skylightWarmHi: 34,        // deg: at/above this the dome is pure daylight
      skylightWarmLo: 18,        // deg: at/below this the re-grade is at full
      skylightHorizon: 0xff8f3f, // the warm horizon band skylight rotates toward
      skylightFillDrop: 0.12,    // fraction of hemi/ambient intensity lost at full
      skylightIblWarmth: 1.0,    // how much of the rotation reaches the sky IBL
      skylightIblDrop: 0.05,     // fraction of diffuse IBL lost at full
    }, opts);

    this._quality = clamp(this.opts.quality | 0, 0, 2);
    this._bounds = [1, 500];
    this._frame = 0;
    this._debug = 0;
    this._nightAmt = 0;
    this._time = 0;
    this._size = new THREE.Vector2(1280, 720);
    this._pixelRatio = 1;

    // ---- scratch (never allocate per frame) --------------------------------
    this._v3a = new THREE.Vector3();
    this._v3b = new THREE.Vector3();
    this._v3c = new THREE.Vector3();
    this._v2a = new THREE.Vector2();
    this._center = new THREE.Vector3();
    this._rot = new THREE.Matrix4();
    this._rotInv = new THREE.Matrix4();
    this._biasMat = new THREE.Matrix4().set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    );
    this._colA = new THREE.Color();
    this._colB = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
    this._zero = new THREE.Vector3(0, 0, 0);

    // ---- celestial ---------------------------------------------------------
    this.sunDir = new THREE.Vector3(-0.42, 0.78, -0.46).normalize();
    this._shadowDir = this.sunDir.clone();
    this._externalSunDir = null;
    this.sunColor = new THREE.Color(1, 1, 1);
    this.skyColor = new THREE.Color(0.8, 0.9, 1);
    this.groundColor = new THREE.Color(0.5, 0.6, 0.35);
    this.intensity = 1.4;
    this.isMoon = false;
    this.elevation = 0.9;

    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.castShadow = false;              // we run our own cascade passes
    this.sun.position.copy(this.opts.mapCenter).addScaledVector(this.sunDir, 500);
    this.sunTarget = new THREE.Object3D();
    this.sunTarget.position.copy(this.opts.mapCenter);
    this.sun.target = this.sunTarget;
    scene.add(this.sun);
    scene.add(this.sunTarget);

    this.hemi = new THREE.HemisphereLight(0xcfe9ff, 0x8fbf6a, 0.62);
    scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xbcd8ff, 0.30);
    scene.add(this.ambient);

    // The skylight re-grade is installed as ACCESSORS on the two fill lights
    // rather than as plain writes — see _installSkylightGrade() for why.
    this._skyWarm = 0;
    this._moonAmt = 0;
    this._installSkylightGrade();
    this._installKeyElevationFloor();

    // ---- CSM state ---------------------------------------------------------
    this._cascades = [];
    for (let i = 0; i < CSM_MAX_CASCADES; i++) {
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 100);
      cam.matrixAutoUpdate = false;
      this._cascades.push({
        cam,
        near: 0, far: 0,
        radius: 1, texelWorld: 1, depthRange: 1,
        centre: new THREE.Vector3(),
        lastCentre: new THREE.Vector3(9e9, 9e9, 9e9),
        lastDir: new THREE.Vector3(),
        lastFrame: -999,
        matrix: new THREE.Matrix4(),
      });
    }

    this.uniforms = {
      uCsmAtlas: { value: null },
      uCsmAtlasTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
      uCsmCount: { value: 0 },
      uCsmTaps: { value: new THREE.Vector4(16, 8, 1, 0) },
      uCsmSplits: { value: mkVec4Array(CSM_MAX_CASCADES) },
      uCsmMatrix: { value: mkMat4Array(CSM_MAX_CASCADES) },
      uCsmParams: { value: mkVec4Array(CSM_MAX_CASCADES) },
      uCsmRect: { value: mkVec4Array(CSM_MAX_CASCADES) },
      uCsmSoft: { value: new THREE.Vector4(0.1, 1.6, 0.055, 3.2) },
      uCsmMisc: { value: new THREE.Vector4(0.94, 0, 1e5, 1e5) },
      uCsmFill: { value: new THREE.Vector4(0.88, 0.46, 0.55, 0) },
      uCsmSky: { value: new THREE.Vector4(10.0, 0.30, 1, 0) },
      uCsmTune: { value: new THREE.Vector4(1.6, 0, 0, 0) },
      uCsmOrigin: { value: new THREE.Vector3() },
      uCsmIblTint: { value: new THREE.Vector3(1, 1, 1) },
      uCsmWallFill: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCsmWallTint: { value: new THREE.Vector3(1, 1, 1) },
      uCsmShadowTint: { value: new THREE.Vector4(1, 1, 1, 0) },
      uCsmKeyDirW: { value: new THREE.Vector3(0, 1, 0) },
      uAoMap: { value: null },
      uAoXf: { value: new THREE.Vector4(0, 0, 0, 0) },
      uAoParams: { value: new THREE.Vector4(0, 0, 0, 0.04) },
      uAoTune: { value: new THREE.Vector4(0.1, 0.07, 1 / 2048, 0) },
      uAoShape: { value: new THREE.Vector4(1, 0.6, 6, 0.2) },
      uAoCover: { value: new THREE.Vector4(0.55, 0.5, 0.35, 0.5) },
      uAoGrad: { value: new THREE.Vector4(0, 1, 0, 0) },
    };
    this._originMat = new THREE.Matrix4();

    this._depthMat = new THREE.ShaderMaterial({
      name: 'CSM.caster',
      uniforms: {},
      vertexShader: CASTER_VERT,
      fragmentShader: CASTER_FRAG,
      side: this.opts.casterSide,
      fog: false,
      lights: false,
    });

    this._atlas = null;
    this._atlasTile = 0;
    this._hidden = [];

    // ---- world AO height volume (see _aoUpdate) ------------------------------
    this._aoTarget = null;
    this._aoRes = 0;
    this._aoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 200);
    this._aoCam.up.set(0, 0, -1);
    this._aoMat = new THREE.ShaderMaterial({
      name: 'CSM.aoHeight',
      uniforms: {},
      vertexShader: AO_VERT,
      fragmentShader: AO_FRAG,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      fog: false,
      lights: false,
    });
    this._aoState = { S: 0, cx: 1e9, cz: 1e9, sig: NaN, frame: -999, sigFrame: -999 };
    this._aoTargetB = null;
    this._aoFloodMat = new THREE.ShaderMaterial({
      name: 'CSM.aoFlood',
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uInit: { value: 0 } },
      vertexShader: AO_QUAD_VERT,
      fragmentShader: AO_FLOOD_FRAG,
      depthTest: false,
      depthWrite: false,
      fog: false,
      lights: false,
    });
    const mkPass = (name, frag, uniforms) => new THREE.ShaderMaterial({
      name, uniforms, vertexShader: AO_QUAD_VERT, fragmentShader: frag,
      depthTest: false, depthWrite: false, fog: false, lights: false,
    });
    this._aoGroundMat = mkPass('CSM.aoGround', AO_GROUND_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uP: { value: new THREE.Vector4(1.2, 0.1, 8, 0) },
      uP2: { value: new THREE.Vector4(4, 0, 0, 0) },
    });
    this._aoCopyMat = mkPass('CSM.aoCopy', AO_COPY_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
    });
    this._aoFloorMat = new THREE.ShaderMaterial({
      name: 'CSM.aoFloor',
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: AO_VERT,
      fragmentShader: AO_FLOOR_FRAG,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      fog: false,
      lights: false,
    });
    this._aoBlurMat = mkPass('CSM.aoBlur', AO_BLUR_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2(1, 0) },
    });
    this._aoQuadScene = new THREE.Scene();
    this._aoQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._aoFloodMat);
    this._aoQuad.frustumCulled = false;
    this._aoQuadScene.add(this._aoQuad);
    this._aoHidden = [];
    this._aoCorner = new THREE.Vector3();
    this._aoDir = new THREE.Vector3();
    this._patched = new Set();

    // ---- night light pools -------------------------------------------------
    this._poolUniforms = { uNight: { value: 0 }, uTime: { value: 0 } };
    this._lampAnchors = [];
    this._windowGlows = [];
    this._poolMesh = null;
    this._glowMesh = null;
    this._poolCap = 0;
    this._glowCap = 0;

    this._applyQuality();
    this._setNightGrade(0);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Shared uniform bag to splice into a material (see csmPatchShader). */
  getShaderUniforms() { return this.uniforms; }

  /**
   * Convenience: wire CSM into a THREE.Material. Chains any existing
   * onBeforeCompile. Call once per material; safe to call repeatedly.
   */
  patchMaterial(material) {
    if (!material || this._patched.has(material)) return material;
    this._patched.add(material);
    const prev = material.onBeforeCompile;
    const uni = this.uniforms;
    material.onBeforeCompile = function (shader, renderer) {
      if (typeof prev === 'function' && prev !== THREE.Material.prototype.onBeforeCompile) {
        prev.call(this, shader, renderer);
      }
      csmPatchShader(shader, uni);
    };
    const prevKey = material.customProgramCacheKey;
    material.customProgramCacheKey = function () {
      const base = (typeof prevKey === 'function') ? prevKey.call(this) : '';
      return base + '|csm';
    };
    material.needsUpdate = true;
    return material;
  }

  /** Quality level 0|1|2 per CONTRACTS-RENDER.md §6. */
  setQuality(level) {
    const q = clamp(level | 0, 0, 2);
    if (q === this._quality) return;
    this._quality = q;
    this._applyQuality();
  }

  getQuality() { return this._quality; }

  /** Explicit cascade count 1..4 (overrides the quality default). */
  setCascadeCount(n) {
    this.opts.cascades = clamp(n | 0, 1, CSM_MAX_CASCADES);
    this._applyQuality();
  }

  /** PCF tap budget (1..16). Does NOT recompile shaders. */
  setPcfTaps(n) {
    const t = clamp(n | 0, 1, 16);
    this.uniforms.uCsmTaps.value.x = t;
    this.uniforms.uCsmTaps.value.y = clamp(Math.round(t * 0.6), 3, 12);
  }

  /** Partial parameter update. */
  setParams(p) {
    if (!p) return;
    Object.assign(this.opts, p);
    if (p.shadowStrength !== undefined) this.uniforms.uCsmMisc.value.x = p.shadowStrength;
    if (p.shadowAmbient !== undefined) this.uniforms.uCsmTaps.value.w = p.shadowAmbient;
    if (p.shadowIbl !== undefined) this.uniforms.uCsmFill.value.x = p.shadowIbl;
    if (p.shadowSpecular !== undefined) this.uniforms.uCsmFill.value.y = p.shadowSpecular;
    if (p.shadowContrast !== undefined) this.uniforms.uCsmFill.value.z = p.shadowContrast;
    if (p.skyContactWorld !== undefined) this.uniforms.uCsmSky.value.x = p.skyContactWorld;
    if (p.skyOpenFloor !== undefined) this.uniforms.uCsmSky.value.y = p.skyOpenFloor;
    if (p.penumbraFloorPixels !== undefined) {
      this.uniforms.uCsmSky.value.w = Math.max(0, p.penumbraFloorPixels);
    }
    if (p.tapDensity !== undefined) this.uniforms.uCsmTune.value.x = Math.max(0, p.tapDensity);
    if (p.rotateBlock !== undefined) this.uniforms.uCsmTaps.value.z = Math.max(0, p.rotateBlock);
    if (p.bilinearTaps !== undefined) {
      this.uniforms.uCsmSky.value.z = (p.bilinearTaps && QUALITY[this._quality].bilinear) ? 1 : 0;
    }
    if (p.softness !== undefined) this.uniforms.uCsmSoft.value.z = p.softness;
    if (p.minPenumbra !== undefined) this.uniforms.uCsmSoft.value.x = p.minPenumbra;
    if (p.maxPenumbra !== undefined) this.uniforms.uCsmSoft.value.w = p.maxPenumbra;
    if (p.blockerSearchWorld !== undefined) this.uniforms.uCsmSoft.value.y = p.blockerSearchWorld;
    this._applyAoParams();
    if (p.lampColor !== undefined || p.lampRadius !== undefined || p.lampIntensity !== undefined || p.lampVary !== undefined ||
        p.lampGlowRadius !== undefined || p.lampGlowIntensity !== undefined || p.windowGlowBillboards !== undefined) {
      this._rebuildPools();
    }
    // Any skylight/moon key change must be visible without waiting for the next
    // update() — the harnesses A/B these live, between renders.
    if (this._fill) this._fill.dirty = true;
    if (this._keyPos) this._keyPos.dirty = true;
    this._skyWarm = this._skylightWarmAmount();
    this._updateIblTint();
  }

  /**
   * Debug view. `false`/`0` = off, `true`/`1` = cascade false-colour.
   * Numeric modes 2..6 are per-fragment instrumentation of the actual lookup:
   *   2 shadow term (grey)   3 atlas UV (r=u, g=v, b=inside-cascade)
   *   4 sampled atlas depth  5 receiver depth in light space
   *   6 signed depth delta (red = occluded, green = lit, black = outside)
   *   7 world-AO visibility, written as the FINAL colour (albedo-free)
   *   8 world-AO height-map probe (r,g = fract(uv*4), b = top - y)
   */
  setDebugCascades(on) {
    this._debug = (on === true) ? 1 : (typeof on === 'number' ? clamp(on | 0, 0, 8) : 0);
    this.uniforms.uCsmMisc.value.y = this._debug;
  }

  /** Alias for setDebugCascades with an explicit numeric mode. */
  setDebugMode(mode) { this.setDebugCascades(mode | 0); }

  getDebugMode() { return this._debug; }

  /** 'internal' = rig drives the sun; 'external' = sky.js drives it. */
  setSunSource(mode) { this.opts.sunSource = (mode === 'external') ? 'external' : 'internal'; }

  /** Inject a sun direction (normalized, scene -> sun). Implies external mode. */
  setSunDirection(v) {
    if (!v) { this._externalSunDir = null; return; }
    if (!this._externalSunDir) this._externalSunDir = new THREE.Vector3();
    this._externalSunDir.copy(v).normalize();
    this.uniforms.uCsmKeyDirW.value.copy(this._externalSunDir);
  }

  /**
   * Directional wall fill (see csmWallFill in the GLSL). `amount` 0..1 is the
   * daytime art blend (engine passes sky.js's artAmount every frame); the
   * strengths come from opts.wallFillAway / wallFillToward / wallFillTint.
   */
  setWallFillAmount(amount) {
    const o = this.opts, u = this.uniforms;
    const a = clamp(amount, 0, 1);
    u.uCsmWallFill.value.set(o.wallFillAway || 0, o.wallFillToward || 0, a, o.wallFillSpec || 0);
    const t = o.wallFillTint || [1, 1, 1];
    u.uCsmWallTint.value.set(t[0], t[1], t[2]);
    const st = o.shadowFillTint || [1, 1, 1];
    u.uCsmShadowTint.value.set(st[0], st[1], st[2], a * (o.shadowFillTintAmount || 0));
  }

  /** The direction the rig is currently using (scene -> sun). Do not mutate. */
  getSunDirection() { return this.sunDir; }

  /** Env map for IBL. Sets scene.environment; materials read envMapIntensity. */
  setEnvironment(tex) {
    this.envMap = tex || null;
    this.scene.environment = tex || null;
  }

  /**
   * Street-lamp anchors. `[{x, z, y?, radius?, intensity?, color?, bulbY?}]`.
   * Renders as ONE instanced additive ground decal draw + ONE billboard draw,
   * regardless of count. No real point lights are created.
   */
  setLampAnchors(list) {
    this._lampAnchors = Array.isArray(list) ? list : [];
    this._rebuildPools();
  }

  /** Optional window-spill glows: `[{x, y, z, radius?, intensity?, color?}]`. */
  setWindowGlows(list) {
    this._windowGlows = Array.isArray(list) ? list : [];
    this._rebuildGlows();
  }

  setSize(w, h, pixelRatio) {
    this._size.set(w || 1, h || 1);
    this._pixelRatio = pixelRatio || 1;
  }

  /** Force a full re-render of every cascade next update (geometry changed). */
  markDirty() {
    for (let i = 0; i < this._cascades.length; i++) this._cascades[i].lastFrame = -999;
  }

  /**
   * Per-frame. MUST run after the camera is positioned and BEFORE post.render.
   * Returns the lighting suggestion for sky/fog modules.
   */
  update(dt, ctx) {
    ctx = ctx || {};
    const camera = ctx.camera || this.camera;
    this.camera = camera;
    this._time += (dt || 0);
    this._frame++;

    const nightT = (typeof ctx.nightEff === 'number') ? ctx.nightEff
      : (typeof ctx.nightT === 'number') ? ctx.nightT : 0;

    this._updateCelestial(nightT, ctx);
    this._setNightGrade(nightT);
    this._updatePools(nightT);
    this._renderCascades(camera);
    this._aoUpdate(camera);

    return {
      sunDir: this.sunDir,
      sunColor: this.sunColor,
      skyColor: this.skyColor,
      groundColor: this.groundColor,
      intensity: this.intensity,
      isMoon: this.isMoon,
      elevation: this.elevation,
      envIntensity: this.opts.envIntensity,
      // The direction the city is actually KEYED from: the sun by day, and by
      // night the moon after `moonKeyElevation` has floored it. sky.js should
      // draw its moon disc here (see _updateCelestial) — disc and key must
      // agree. `elevation` above stays the raw, signed elevation of the body as
      // handed to us, per §3.8.2.
      keyDir: this._keyDir,
      keyElevation: this._keyDir ? Math.asin(clamp(this._keyDir.y, -1, 1)) : this.elevation,
      skylightWarmth: this._skyWarm,
    };
  }

  dispose() {
    if (this._atlas) { this._atlas.dispose(); this._atlas = null; }
    if (this._aoTarget) { this._aoTarget.dispose(); this._aoTarget = null; }
    if (this._aoTargetB) { this._aoTargetB.dispose(); this._aoTargetB = null; }
    this._aoMat.dispose();
    this._aoFloodMat.dispose();
    this._aoGroundMat.dispose();
    this._aoBlurMat.dispose();
    this._aoCopyMat.dispose();
    this._aoFloorMat.dispose();
    this._aoQuad.geometry.dispose();
    this._depthMat.dispose();
    if (this._poolMesh) { this._disposeInstanced(this._poolMesh); this._poolMesh = null; }
    if (this._glowMesh) { this._disposeInstanced(this._glowMesh); this._glowMesh = null; }
    this.scene.remove(this.sun);
    this.scene.remove(this.sunTarget);
    this.scene.remove(this.hemi);
    this.scene.remove(this.ambient);
    this.sun.dispose();
    this.hemi.dispose();
    this.ambient.dispose();
    this.uniforms.uCsmAtlas.value = null;
    this.uniforms.uCsmCount.value = 0;
    this._patched.clear();
  }

  // -------------------------------------------------------------------------
  // Internals — quality / targets
  // -------------------------------------------------------------------------

  _applyQuality() {
    const q = QUALITY[this._quality];
    // A quality switch changes the world-AO map resolution: re-render it (its
    // own dirty test only watches the view footprint and the scene).
    if (this._aoState) this._aoState.S = -1;
    const count = clamp((this.opts.cascades || q.cascades), 1, CSM_MAX_CASCADES);
    const tile = this.opts.shadowTile || q.tile;
    this._count = count;
    this._farScale = q.farScale;
    const rot = (this.opts.rotateBlock === undefined || this.opts.rotateBlock === null)
      ? q.rotate : Math.max(0, this.opts.rotateBlock);
    this.uniforms.uCsmTaps.value.set(q.taps, q.search, rot, this.opts.shadowAmbient);
    this.uniforms.uCsmSoft.value.set(
      this.opts.minPenumbra, this.opts.blockerSearchWorld,
      this.opts.softness, this.opts.maxPenumbra
    );
    this.uniforms.uCsmMisc.value.x = this.opts.shadowStrength;
    this.uniforms.uCsmMisc.value.y = this._debug;
    this.uniforms.uCsmFill.value.set(
      this.opts.shadowIbl, this.opts.shadowSpecular, this.opts.shadowContrast,
      this.uniforms.uCsmFill.value.w      // pixel scale: republished every frame
    );
    this.uniforms.uCsmSky.value.set(
      this.opts.skyContactWorld, this.opts.skyOpenFloor,
      (this.opts.bilinearTaps && q.bilinear) ? 1 : 0,
      Math.max(0, this.opts.penumbraFloorPixels)
    );
    this.uniforms.uCsmTune.value.x = Math.max(0, this.opts.tapDensity);
    this._applyAoParams();
    this._ensureAtlas(tile, count);
    this.markDirty();
  }

  _ensureAtlas(tile, count) {
    // Iso layout (orthographic camera): [ cascade 0: isoTile^2 | cascade 1: tile^2 ].
    const q = QUALITY[this._quality];
    const iso = !!(this.camera && this.camera.isOrthographicCamera) && this.opts.isoLayout !== false;
    const isoTile = iso ? (this.opts.isoTile || q.isoTile || tile) : 0;
    const grid = iso ? -1 : ((count <= 1) ? 1 : 2);
    const key = tile + ':' + grid + ':' + isoTile + ':' + count;
    if (this._atlas && this._atlasKey === key) return;
    let W, H;
    const rects = [];
    if (iso) {
      W = isoTile + (count > 1 ? tile : 0);
      H = Math.max(isoTile, tile);
      rects.push([0, 0, isoTile, isoTile]);
      for (let i = 1; i < CSM_MAX_CASCADES; i++) rects.push([isoTile, 0, tile, tile]);
    } else {
      W = H = tile * grid;
      for (let i = 0; i < CSM_MAX_CASCADES; i++) {
        const gx = (grid === 1) ? 0 : (i % 2);
        const gy = (grid === 1) ? 0 : ((i / 2) | 0);
        rects.push([gx * tile, gy * tile, tile, tile]);
      }
    }
    if (this._atlas) this._atlas.dispose();
    const rt = new THREE.WebGLRenderTarget(W, H, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.name = 'CSM.atlas';
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    rt.texture.generateMipmaps = false;
    this._atlas = rt;
    this._atlasKey = key;
    this._atlasTile = tile;
    this._atlasGrid = grid;
    this._iso = iso;
    this._isoTile = isoTile;
    this._rects = rects;
    this._atlasCleared = false;
    this.uniforms.uCsmAtlas.value = rt.texture;
    this.uniforms.uCsmAtlasTexel.value.set(1 / W, 1 / H);
    for (let i = 0; i < CSM_MAX_CASCADES; i++) {
      const r = rects[i];
      this.uniforms.uCsmRect.value[i].set(r[0] / W, r[1] / H, r[2] / W, r[3] / H);
    }
    // Shader switches: y = iso coverage mode, z = grid-filter half width (texels).
    this.uniforms.uCsmTune.value.y = iso ? 1 : 0;
    this.uniforms.uCsmTune.value.z = iso ? (this.opts.isoGrid || q.isoGrid || 0) : 0;
    for (const c of this._cascades) { c.lastFrame = -999; c.lastCentre.set(9e9, 9e9, 9e9); }
  }

  _tileRect(i) {
    return this._rects[i];
  }

  // -------------------------------------------------------------------------
  // Internals — celestial rig
  // -------------------------------------------------------------------------

  _updateCelestial(nightT, ctx) {
    const o = this.opts;
    if (this._keyPos) this._keyPos.dirty = true;

    if (o.sunSource === 'external') {
      const ext = this._externalSunDir || (ctx.sunDir && ctx.sunDir.isVector3 ? ctx.sunDir : null);
      if (ext) this.sunDir.copy(ext).normalize();
    } else {
      // Elevation arcs from +maxSunElevation (noon) through 0 (t=0.5) to
      // -maxSunElevation (midnight); azimuth sweeps so light rakes across.
      // The pow() flattens the curve near the horizon so the game LINGERS in
      // the 10-25 degree golden-hour band instead of skating through it —
      // that band is where the long raking shadows live.
      const c = Math.cos(nightT * Math.PI);
      const elevDeg = o.maxSunElevation * Math.sign(c) * Math.pow(Math.abs(c), o.horizonEase);
      const az = o.azimuthBase + (typeof ctx.dayPhase === 'number' ? ctx.dayPhase : nightT) * o.azimuthSweep;
      const e = elevDeg * DEG;
      const ce = Math.cos(e);
      this.sunDir.set(Math.sin(az) * ce, Math.sin(e), Math.cos(az) * ce).normalize();
    }

    this.elevation = Math.asin(clamp(this.sunDir.y, -1, 1));

    // --- which body is the key? ---------------------------------------------
    // INTERNAL: we drew the arc ourselves, so "below the horizon" is the answer
    // and the moon is the mirrored arc (it peaks at maxSunElevation at
    // midnight, which is a real arc already).
    //
    // EXTERNAL: sky.js hands us `keyDir`, which is ALREADY the moon at night —
    // above the horizon, by design. `sunDir.y < 0` therefore reported isMoon
    // FALSE at nightT 0.92, and every downstream consumer (shadow strength, the
    // skylight re-grade, engine's night grade) was told the 4.3-degree moon was
    // a sunrise. Use the clock instead: it is the only signal that survives the
    // handover.
    const moonAmt = (o.sunSource === 'external')
      ? smoothstep(o.moonAfterLo, o.moonAfterHi, nightT)
      : (this.sunDir.y < 0 ? 1 : 0);
    this._moonAmt = moonAmt;
    this.isMoon = moonAmt > 0.5;

    // The light we actually shade with: below the horizon we flip to the moon
    // (same arc, opposite hemisphere) so the city keeps a directional key.
    const L = this._v3a.copy(this.sunDir);
    if (L.y < 0) L.negate();

    // --- the moon has to be ON AN ARC ---------------------------------------
    // sky.js authors its moon at a fixed ~4.3 degrees ("it hangs low, which is
    // the only band of sky this camera frames"). A key light at 4.3 degrees
    // hands a horizontal surface sin(4.3) = 0.075 of itself: roads and roofs get
    // no directional read at all, and the moon shapes nothing. Floor the KEY's
    // elevation (light + cascades together, so shading and shadows still agree
    // with each other) and let the azimuth stand — the raking direction is the
    // part the disc's position actually reads out.
    //
    // The DISC is sky.js's to place, and disc and key must agree: the real fix
    // is for sky.js to raise `_moonElev` onto the same arc, at which point this
    // floor stops firing on its own and can be set to null.
    // The floor is scaled by `_moonAmt`, so over the handover band it reads as
    // the moon CLIMBING out of the dusk rather than teleporting: a boolean
    // switch would jump the key (and every shadow in the city) from 4 degrees to
    // 30 in a single frame.
    if (moonAmt > 0 && o.moonKeyElevation != null) {
      const minMoon = Math.sin(clamp(o.moonKeyElevation, 0, 89) * DEG) * moonAmt;
      if (L.y < minMoon) {
        const h = Math.hypot(L.x, L.z) || 1e-4;
        const k = Math.sqrt(Math.max(0, 1 - minMoon * minMoon)) / h;
        L.set(L.x * k, minMoon, L.z * k).normalize();
      }
    }
    this._keyDir = this._keyDir || new THREE.Vector3();
    this._keyDir.copy(L);

    // Shadow direction: clamp to a minimum elevation so the ortho frustum stays
    // sane, and fade shadow strength out as the sun grazes the horizon.
    const minE = o.minShadowElevation * DEG;
    this._shadowDir.copy(L);
    if (this._shadowDir.y < Math.sin(minE)) {
      const h = Math.hypot(this._shadowDir.x, this._shadowDir.z) || 1e-4;
      const targetY = Math.sin(minE);
      const scaleH = Math.cos(minE) / h;
      this._shadowDir.set(this._shadowDir.x * scaleH, targetY, this._shadowDir.z * scaleH).normalize();
    }

    const rawElev = Math.abs(Math.asin(clamp(L.y, -1, 1)));
    let strength = smoothstep(o.shadowFadeLo * DEG, o.shadowFadeHi * DEG, rawElev);
    // NOTE: fixing isMoon (above) is what finally lets this branch RUN in the
    // shipping game — in 'external' mode isMoon was permanently false, so the
    // moon has been casting full-strength daylight shadows all along. Measured
    // at the `night` shot, activating it takes the cascade strength 0.97 ->
    // 0.533. That is the authored intent (moonlight is a softer key), but it is
    // a real change to night contrast, so the factor is an option now rather
    // than a literal: raise `moonShadowStrength` if night wants more bite.
    if (this.isMoon) {
      const mf = (o.moonShadowStrength === undefined) ? 0.55 : o.moonShadowStrength;
      strength *= (o.moonShadows ? clamp(mf, 0, 1) : 0);
    }
    this.uniforms.uCsmMisc.value.x = o.shadowStrength * strength;

    // set(), not copy().addScaledVector(): sun.position carries the moon
    // elevation floor as accessors (see _installKeyElevationFloor), and a
    // read-modify-write through a filtering accessor would fold the floor in
    // twice. Every writer of this light must assign, never accumulate.
    this.sun.position.set(
      o.mapCenter.x + L.x * 600,
      o.mapCenter.y + L.y * 600,
      o.mapCenter.z + L.z * 600
    );
    this.sunTarget.position.copy(o.mapCenter);
    this.sun.updateMatrixWorld();
    this.sunTarget.updateMatrixWorld();
  }

  // -------------------------------------------------------------------------
  // Internals — low-sun skylight re-grade
  // -------------------------------------------------------------------------

  /**
   * How much the dome has stopped being a blue zenith and become a warm horizon
   * band. 0 = high sun (pure daylight), 1 = fully re-graded. Never fires for the
   * moon: moonlight is a cool key over a cool dome, and warming it would turn
   * midnight into a campfire.
   */
  _skylightWarmAmount() {
    const o = this.opts;
    const master = clamp(o.skylightWarmth === undefined ? 1 : o.skylightWarmth, 0, 1);
    if (master <= 0) return 0;
    const elevDeg = this.elevation * RAD;
    const lowness = 1 - smoothstep(o.skylightWarmLo, o.skylightWarmHi, elevDeg);
    return lowness * (1 - clamp(this._moonAmt, 0, 1)) * master;
  }

  /**
   * Rotate `src` toward `dst`'s HUE at `src`'s own luminance, by `w`.
   *
   * Luminance preservation is the whole trick. The fill is what fills the
   * shadows, so re-colouring it by simply lerping toward an orange would drop
   * the blue channel's luma contribution and quietly deepen every shadow — the
   * lit:shadow ratios in this rig are measured and defended, and a colour fix
   * is not allowed to move them. Normalising the target to the source's
   * luminance first means the swing is (nearly) pure chroma: red and green rise
   * by as much as blue falls.
   */
  _rotateToward(src, dst, w, out) {
    const ls = 0.2126 * src.r + 0.7152 * src.g + 0.0722 * src.b;
    const ld = 0.2126 * dst.r + 0.7152 * dst.g + 0.0722 * dst.b;
    const k = ls / Math.max(ld, 1e-5);
    out.setRGB(
      src.r + (dst.r * k - src.r) * w,
      src.g + (dst.g * k - src.g) * w,
      src.b + (dst.b * k - src.b) * w
    );
    return out;
  }

  /**
   * Install the skylight re-grade as ACCESSORS on the hemisphere/ambient lights.
   *
   * WHY ACCESSORS AND NOT PLAIN WRITES. The rig owns these two lights
   * (CONTRACTS-RENDER.md §3.8) but it is not the only writer: `engine.js`
   * adopts them and, in `_applySkyLighting()`, copies sky.js's analytic solution
   * onto them EVERY FRAME, AFTER `update()` has run. Anything the rig assigns
   * inside `update()` is therefore dead on arrival — which is exactly how the
   * fill came to sit at daylight blue (#48b3ff @ 0.434) under a 2.83:1 warm sun.
   *
   * So the split is: whoever writes owns the BASE (the daylight tint and level
   * for this hour), and the rig owns the elevation-driven GRADE of it. Writes
   * land in `_fill.base`; reads — three's WebGLLights reads `.color.r/.g/.b` and
   * `.intensity` once per frame, at render time, which is after every writer has
   * had its say — return `_fill.out`. Nobody has to be reordered and nothing has
   * to know about anyone else.
   *
   * A write whose value is EXACTLY our last emitted output is treated as an echo
   * (someone feeding update()'s return value back in) and does not disturb the
   * base, so the grade can never compound on itself.
   */
  _installSkylightGrade() {
    const rig = this;
    const F = this._fill = {
      base: {
        sky: new THREE.Color().copy(this.hemi.color),
        gnd: new THREE.Color().copy(this.hemi.groundColor),
        amb: new THREE.Color().copy(this.ambient.color),
        hemiI: this.hemi.intensity,
        ambI: this.ambient.intensity,
      },
      out: {
        sky: new THREE.Color().copy(this.hemi.color),
        gnd: new THREE.Color().copy(this.hemi.groundColor),
        amb: new THREE.Color().copy(this.ambient.color),
        hemiI: this.hemi.intensity,
        ambI: this.ambient.intensity,
      },
      dirty: true,
    };

    const bindColor = (owner, key) => {
      for (const ch of ['r', 'g', 'b']) {
        Object.defineProperty(owner, ch, {
          configurable: true,
          enumerable: true,
          get() { rig._gradeSkylight(); return F.out[key][ch]; },
          set(v) {
            if (v === F.out[key][ch]) return;      // our own output, echoed back
            F.base[key][ch] = v;
            F.dirty = true;
          },
        });
      }
    };
    const bindScalar = (owner, prop, key) => {
      Object.defineProperty(owner, prop, {
        configurable: true,
        enumerable: true,
        get() { rig._gradeSkylight(); return F.out[key]; },
        set(v) {
          if (v === F.out[key]) return;
          F.base[key] = v;
          F.dirty = true;
        },
      });
    };

    bindColor(this.hemi.color, 'sky');
    bindColor(this.hemi.groundColor, 'gnd');
    bindColor(this.ambient.color, 'amb');
    bindScalar(this.hemi, 'intensity', 'hemiI');
    bindScalar(this.ambient, 'intensity', 'ambI');
  }

  /**
   * Keep the moon key's elevation floor applied to `sun.position`.
   *
   * Same reason as the fill accessors: `engine.js` re-places this light from
   * sky.js's `keyDir` every frame, AFTER `update()` has run and after the
   * cascades have already been rendered from the floored direction. Without
   * this guard the shadows would be cast from a 30-degree moon while the
   * shading came from a 4.3-degree one — the one failure mode worse than a flat
   * night. The floor is idempotent (re-flooring a floored direction is a no-op)
   * and self-retiring: once sky.js's moon arc clears `moonKeyElevation`, or
   * that option is set to null, this returns the written position untouched.
   */
  _installKeyElevationFloor() {
    const rig = this;
    const p = this.sun.position;
    const base = { x: p.x, y: p.y, z: p.z };
    const out = { x: p.x, y: p.y, z: p.z };
    this._keyPos = { base, out, dirty: true };

    const recompute = () => {
      const s = rig._keyPos;
      if (!s.dirty) return;
      s.dirty = false;
      const o = rig.opts;
      const t = rig.sunTarget ? rig.sunTarget.position : null;
      const tx = t ? t.x : 0, ty = t ? t.y : 0, tz = t ? t.z : 0;
      let dx = s.base.x - tx, dy = s.base.y - ty, dz = s.base.z - tz;
      const len = Math.hypot(dx, dy, dz) || 1;
      const minY = (rig._moonAmt > 0 && o.moonKeyElevation != null)
        ? Math.sin(clamp(o.moonKeyElevation, 0, 89) * DEG) * rig._moonAmt : -2;
      const ny = dy / len;
      if (ny < minY) {
        const h = Math.hypot(dx, dz) || 1e-4;
        const k = Math.sqrt(Math.max(0, 1 - minY * minY)) * len / h;
        dx *= k; dz *= k; dy = minY * len;
      }
      s.out.x = tx + dx; s.out.y = ty + dy; s.out.z = tz + dz;
    };

    for (const ch of ['x', 'y', 'z']) {
      Object.defineProperty(p, ch, {
        configurable: true,
        enumerable: true,
        get() { recompute(); return rig._keyPos.out[ch]; },
        set(v) {
          if (v === rig._keyPos.out[ch]) return;   // our own output, echoed back
          rig._keyPos.base[ch] = v;
          rig._keyPos.dirty = true;
        },
      });
    }
  }

  /** Recompute `_fill.out` (and the IBL tint uniform) from base + warm amount. */
  _gradeSkylight() {
    const F = this._fill;
    if (!F || !F.dirty) return;
    F.dirty = false;
    const o = this.opts;
    const w = this._skyWarm;
    const horizon = this._horizonColor || (this._horizonColor = new THREE.Color());
    if (this._horizonHex !== o.skylightHorizon) {
      this._horizonHex = o.skylightHorizon;
      horizon.setHex(o.skylightHorizon, THREE.SRGBColorSpace);
    }
    if (w <= 0) {
      F.out.sky.copy(F.base.sky);
      F.out.gnd.copy(F.base.gnd);
      F.out.amb.copy(F.base.amb);
      F.out.hemiI = F.base.hemiI;
      F.out.ambI = F.base.ambI;
      return;
    }
    this._rotateToward(F.base.sky, horizon, w, F.out.sky);
    // The ground bounce is already partly warm (it is lit by the same low sun),
    // so it needs less of the rotation than the sky half does.
    this._rotateToward(F.base.gnd, horizon, w * 0.5, F.out.gnd);
    this._rotateToward(F.base.amb, horizon, w, F.out.amb);
    const drop = 1 - clamp(o.skylightFillDrop, 0, 1) * w;
    F.out.hemiI = F.base.hemiI * drop;
    F.out.ambI = F.base.ambI * drop;
  }

  /**
   * The same re-grade, for the diffuse sky IBL. The PMREM is not ours to
   * rewrite (sky.js renders it, and the player can see the dome it came from),
   * so the rotation is applied in the shader as a multiply — see csmIblTint().
   */
  _updateIblTint() {
    const o = this.opts;
    const w = this._skyWarm * clamp(o.skylightIblWarmth === undefined ? 1 : o.skylightIblWarmth, 0, 1);
    const t = this.uniforms.uCsmIblTint.value;
    if (w <= 0) { t.set(1, 1, 1); return; }
    const horizon = this._horizonColor || (this._horizonColor = new THREE.Color());
    if (this._horizonHex !== o.skylightHorizon) {
      this._horizonHex = o.skylightHorizon;
      horizon.setHex(o.skylightHorizon, THREE.SRGBColorSpace);
    }
    // Normalised to luminance 1, so the multiply is a hue rotation and not a
    // brightness change; `skylightIblDrop` is the (separate, deliberate) dim.
    const ld = Math.max(1e-5, 0.2126 * horizon.r + 0.7152 * horizon.g + 0.0722 * horizon.b);
    const dim = 1 - clamp(o.skylightIblDrop, 0, 1) * this._skyWarm;
    t.set(
      (1 + (horizon.r / ld - 1) * w) * dim,
      (1 + (horizon.g / ld - 1) * w) * dim,
      (1 + (horizon.b / ld - 1) * w) * dim
    );
  }

  _setNightGrade(t) {
    const g = gradeAt(t);
    const e = this.opts.exposure;
    const f = e * this.opts.fillBoost;

    // Elevation-driven skylight first: the fill accessors read `_skyWarm`.
    this._skyWarm = this._skylightWarmAmount();
    if (this._fill) this._fill.dirty = true;
    this._updateIblTint();
    this.sunColor.copy(g.sun);
    this.skyColor.copy(g.sky);
    this.groundColor.copy(g.gnd);
    this.intensity = g.si * e;

    this.sun.color.copy(g.sun);
    this.sun.intensity = g.si * e;
    this.hemi.color.copy(g.sky);
    this.hemi.groundColor.copy(g.gnd);
    this.hemi.intensity = g.hi * f;
    this.ambient.color.copy(g.amb);
    this.ambient.intensity = g.ai * f;
  }

  // -------------------------------------------------------------------------
  // Internals — CSM fit + render
  // -------------------------------------------------------------------------

  /**
   * View-space depth range that actually contains shadow-relevant geometry.
   *
   * This is the difference between a CSM that works and one that wastes every
   * near cascade: Blockville's camera orbits 30..380 units away from a flat
   * city, so `camera.near = 1` means cascade 0 would otherwise be fitted to
   * ~30 units of EMPTY AIR in front of the lens. We intersect the four frustum
   * corner rays with the world slab y in [-4, maxCasterHeight] and take the
   * near-most entry / far-most exit. Quantised so panning and zooming step in
   * bands instead of refitting (and re-snapping) every frame.
   */
  _depthBounds(camera, out) {
    if (camera.isOrthographicCamera) return this._depthBoundsOrtho(camera, out);
    const o = this.opts;
    const cap = Math.min(o.maxShadowDistance, camera.far);
    const yHi = o.maxCasterHeight;
    const yLo = -4;

    const tanV = Math.tan((camera.fov || 40) * 0.5 * DEG);
    const tanH = tanV * (camera.aspect || 1.6);
    const px = camera.position.y;

    const fwd = this._v3c.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();

    let dMin = Infinity, dMax = 0;
    const d = this._v3a;
    for (let s = 0; s < 4; s++) {
      const sx = (s & 1) ? 1 : -1;
      const sy = (s & 2) ? 1 : -1;
      d.set(sx * tanH, sy * tanV, -1).applyQuaternion(camera.quaternion).normalize();
      const proj = d.dot(fwd);                    // ray length -> view depth
      if (proj <= 1e-4) continue;
      const tCap = cap / proj;
      let ta = 0, tb = tCap;
      if (Math.abs(d.y) < 1e-5) {
        if (px < yLo || px > yHi) continue;       // ray never enters the slab
      } else {
        const t1 = (yHi - px) / d.y;
        const t2 = (yLo - px) / d.y;
        ta = Math.max(0, Math.min(t1, t2));
        tb = Math.min(tCap, Math.max(t1, t2));
        if (tb <= ta) continue;
      }
      dMin = Math.min(dMin, ta * proj);
      dMax = Math.max(dMax, tb * proj);
    }

    if (!isFinite(dMin) || dMax <= dMin) { dMin = camera.near; dMax = cap; }
    dMin = Math.max(camera.near, dMin);
    dMax = clamp(dMax, dMin + 16, cap);
    if (o.shadowDistance) dMax = Math.min(dMax, o.shadowDistance);
    dMax = Math.max(dMax, Math.min(o.minShadowDistance, cap));

    // Quantise: stability beats a perfectly tight fit.
    out[0] = Math.max(camera.near, Math.floor(dMin / 8) * 8);
    out[1] = Math.ceil(dMax / 32) * 32 * this._farScale;
    out[1] = Math.max(out[1], out[0] + 24);
    return out;
  }

  /**
   * Orthographic variant of _depthBounds (the game camera is a true-isometric
   * OrthographicCamera). Corner rays are PARALLEL (all along the view axis),
   * starting from the four corners of the view rectangle on the camera plane.
   * View depth may be NEGATIVE: engine.js sits the ortho camera at the old
   * orbit distance and uses a negative near plane so tall towers never clip.
   * The shadow distance caps are therefore applied RELATIVE to the near-most
   * caster, not as absolute view depths.
   */
  _depthBoundsOrtho(camera, out) {
    const o = this.opts;
    const yHi = o.maxCasterHeight;
    const yLo = -4;
    const z = camera.zoom || 1;
    const hw = (camera.right - camera.left) * 0.5 / z;
    const hh = (camera.top - camera.bottom) * 0.5 / z;
    camera.updateMatrixWorld();
    const pos = this._v3b.setFromMatrixPosition(camera.matrixWorld);
    const fwd = this._v3c.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    const right = this._v3a.set(1, 0, 0).applyQuaternion(camera.quaternion);
    // Only the Y components matter for the slab test: y(t) = y0 + fwd.y * t.
    const upV = this._center.set(0, 1, 0).applyQuaternion(camera.quaternion);
    let dMin = Infinity, dMax = -Infinity;
    for (let s = 0; s < 4; s++) {
      const sx = (s & 1) ? 1 : -1;
      const sy = (s & 2) ? 1 : -1;
      const y0 = pos.y + right.y * sx * hw + upV.y * sy * hh;
      if (Math.abs(fwd.y) < 1e-5) continue;
      const t1 = (yHi - y0) / fwd.y;       // ray starts on the camera plane (depth 0)
      const t2 = (yLo - y0) / fwd.y;
      dMin = Math.min(dMin, t1, t2);
      dMax = Math.max(dMax, t1, t2);
    }
    const near = Number.isFinite(camera.near) ? camera.near : 0;
    const far = Number.isFinite(camera.far) ? camera.far : 3000;
    if (!isFinite(dMin) || dMax <= dMin) { dMin = near; dMax = far; }
    dMin = Math.max(near, dMin);
    dMax = Math.min(far, dMax, dMin + o.maxShadowDistance);
    if (o.shadowDistance) dMax = Math.min(dMax, dMin + o.shadowDistance);
    dMax = Math.max(dMax, dMin + 24);
    out[0] = Math.floor(dMin / 8) * 8;
    out[1] = Math.ceil(dMax / 32) * 32;
    out[1] = Math.max(out[1], out[0] + 24);
    return out;
  }

  _camDist(camera) {
    return camera.position.distanceTo(this.opts.mapCenter);
  }

  /** Last fitted shadow distance (view-space), for debug/HUD. */
  _shadowFar() { return this._bounds[1]; }

  _computeSplits(near, far, count, lambda) {
    const out = [near];
    for (let i = 1; i < count; i++) {
      const p = i / count;
      const log = near * Math.pow(far / near, p);
      const uni = near + (far - near) * p;
      out.push(lambda * log + (1 - lambda) * uni);
    }
    out.push(far);
    return out;
  }

  _renderCascades(camera) {
    const renderer = this.renderer;
    if (!renderer || !this._atlas) return;
    const count = this._count;

    this._depthBounds(camera, this._bounds);
    const near = this._bounds[0];
    const far = this._bounds[1];
    const ortho = !!camera.isOrthographicCamera;
    let splits;
    if (ortho) {
      // Near may be <= 0 for the ortho camera: split a shifted, positive range.
      // Every pixel has the same world footprint in ortho, so lean uniform.
      const sh = 1 - near;
      splits = this._computeSplits(1, far + sh, count, Math.min(0.5, this.opts.splitLambda));
      for (let i = 0; i < splits.length; i++) splits[i] -= sh;
    } else {
      splits = this._computeSplits(near, far, count, this.opts.splitLambda);
    }
    const oz = camera.zoom || 1;
    const ohw = ortho ? (camera.right - camera.left) * 0.5 / oz : 0;
    const ohh = ortho ? (camera.top - camera.bottom) * 0.5 / oz : 0;

    // ---- fit every cascade -------------------------------------------------
    const L = this._shadowDir;
    this._rot.identity();
    this._rot.lookAt(L, this._zero, this._up);
    this._rotInv.copy(this._rot).transpose();

    const tanV = Math.tan((camera.fov || 40) * 0.5 * DEG);
    const tanH = tanV * (camera.aspect || 1.6);
    const a2 = tanH * tanH + tanV * tanV;

    // World units covered by ONE DEVICE PIXEL, per unit of view Z. The shader
    // floors its filter footprint at `penumbraFloorPixels` of these, which is
    // what makes the penumbra width distance- and resolution-invariant (see the
    // long note in csmApply). Measured off the DRAWING BUFFER, not the CSS
    // size, because that is what post.js allocates its scene target at, and
    // recomputed every frame because fov, aspect and DPR all move at runtime.
    // Orthographic cameras have no viewZ term at all: publish 0, which disables
    // the floor rather than silently applying a wrong one.
    let pixScale = 0;
    if (camera.isPerspectiveCamera !== false && camera.fov) {
      const bufH = (renderer.getDrawingBufferSize ? renderer.getDrawingBufferSize(this._v2a).y : 0)
        || (this._size.y * this._pixelRatio) || 1;
      pixScale = 2 * Math.tan(camera.fov * 0.5 * DEG) / Math.max(1, bufH);
    }
    this.uniforms.uCsmFill.value.w = pixScale;

    camera.updateMatrixWorld();
    const camPos = this._v3b.setFromMatrixPosition(camera.matrixWorld);
    const camFwd = this._v3c.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();

    // Shading origin: keeps the world-position varying small (precision) and is
    // quantised so it does not jitter the folded matrices every frame.
    const org = this.uniforms.uCsmOrigin.value;
    org.set(Math.round(camPos.x / 32) * 32, 0, Math.round(camPos.z / 32) * 32);
    this._originMat.makeTranslation(org.x, org.y, org.z);

    const anyDirty = [];
    const cacheOn = this.opts.cacheStatic !== false;
    let casterDirty = false;
    if (cacheOn) {
      const sig = this._casterSig(this.scene);
      casterDirty = sig !== this._lastCasterSig;
      this._lastCasterSig = sig;
    }
    // Iso layout: cascade 0 = tight rect over the screen, cascade 1 = the
    // whole view (fallback for receivers above the fit height). See QUALITY.
    const isoFit = !!(this._iso && ortho);
    const effCount = isoFit ? Math.min(count, 2) : count;

    for (let i = 0; i < effCount; i++) {
      const c = this._cascades[i];
      let n = splits[i], f = splits[i + 1];
      if (isoFit) { n = near; f = far; }
      c.near = n; c.far = f;
      const tile = this._rects[i][2];
      const cam = c.cam;
      let texel, depthRange, fitKey;

      if (isoFit && i === 0) {
        // ---- tight light-space rectangle over what the iso camera shows ----
        // Receivers = the screen's 4 corner rays clipped to the slab
        // [isoFitLow, isoFitHeight]; casters = anything up to maxCasterHeight
        // standing on them (the depth range extends toward the light).
        const o = this.opts;
        const yLo = o.isoFitLow, yHi = o.isoFitHeight;
        const right = this._v3a.set(1, 0, 0).applyQuaternion(camera.quaternion);
        const upV = this._isoUp || (this._isoUp = new THREE.Vector3());
        upV.set(0, 1, 0).applyQuaternion(camera.quaternion);
        const P = this._isoP || (this._isoP = new THREE.Vector3());
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        const Ly = Math.max(0.05, L.y);
        const fy = Math.abs(camFwd.y) > 1e-4 ? camFwd.y : -1e-4;
        for (let s = 0; s < 8; s++) {
          const sx = (s & 1) ? 1 : -1, sy = (s & 2) ? 1 : -1;
          const yy = (s & 4) ? yHi : yLo;
          P.copy(camPos).addScaledVector(right, sx * ohw).addScaledVector(upV, sy * ohh);
          P.addScaledVector(camFwd, (yy - P.y) / fy);
          const py = P.y;
          P.applyMatrix4(this._rotInv);
          x0 = Math.min(x0, P.x); x1 = Math.max(x1, P.x);
          y0 = Math.min(y0, P.y); y1 = Math.max(y1, P.y);
          z0 = Math.min(z0, P.z);
          z1 = Math.max(z1, P.z + (o.maxCasterHeight - py) / Ly);
        }
        // Quantised extents: the texel size only changes in whole steps while
        // zooming, never while panning (no shadow swim).
        const qs = o.isoFitStep;
        const hx = Math.ceil(((x1 - x0) * 0.5 + o.isoFitMargin) / qs) * qs;
        const hy = Math.ceil(((y1 - y0) * 0.5 + o.isoFitMargin) / qs) * qs;
        const tx = (2 * hx) / tile, ty = (2 * hy) / tile;
        texel = Math.max(tx, ty);
        const cx = Math.round(((x0 + x1) * 0.5) / tx) * tx;
        const cy = Math.round(((y0 + y1) * 0.5) / ty) * ty;
        const zTop = Math.ceil((z1 + 4) / 8) * 8;
        depthRange = Math.ceil((zTop - z0 + 6) / 8) * 8;
        c.radius = Math.max(hx, hy);
        c.texelWorld = texel;
        this._center.set(cx, cy, zTop).applyMatrix4(this._rot);
        cam.left = -hx; cam.right = hx; cam.top = hy; cam.bottom = -hy;
        cam.near = 0.05; cam.far = depthRange;
        cam.updateProjectionMatrix();
        cam.position.copy(this._center);
        fitKey = hx * 7919 + hy * 13 + depthRange;
      } else {
        // Optimal bounding sphere of the frustum slice (rotation invariant, so
        // the fit does not change as the camera orbits => no shadow swim).
        let cz, R;
        if (ortho) {
          // Ortho slice is a box: centre mid-depth, radius = half its diagonal.
          cz = (n + f) * 0.5;
          R = Math.sqrt(ohw * ohw + ohh * ohh + (f - n) * (f - n) * 0.25);
        } else {
          cz = (a2 + 1) * (n + f) * 0.5;
          if (cz > f) { cz = f; R = f * Math.sqrt(a2); }
          else { R = Math.sqrt(f * f * a2 + (cz - f) * (cz - f)); }
        }
        R = Math.max(R, 1);

        texel = (2 * R) / tile;
        c.radius = R;
        c.texelWorld = texel;

        // Sphere centre in world space, then snapped to the shadow texel grid.
        this._center.copy(camPos).addScaledVector(camFwd, cz);
        this._center.applyMatrix4(this._rotInv);
        this._center.x = Math.round(this._center.x / texel) * texel;
        this._center.y = Math.round(this._center.y / texel) * texel;
        this._center.applyMatrix4(this._rot);

        const back = R + this.opts.maxCasterHeight + 8;
        depthRange = back + R + this.opts.maxCasterHeight + 8;

        cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
        cam.near = 0.05; cam.far = depthRange;
        cam.updateProjectionMatrix();
        cam.position.copy(this._center).addScaledVector(L, back);
        fitKey = R * 7919 + depthRange;
      }
      c.depthRange = depthRange;
      cam.up.copy(this._up);
      // NOT cam.lookAt(): these cameras have matrixAutoUpdate = false, and
      // Object3D.lookAt() calls updateWorldMatrix() first — which, with
      // autoupdate off, re-reads the position out of the PREVIOUS frame's
      // matrixWorld instead of the one we just assigned. The orientation then
      // lags a frame (subtly wrong shadows whenever the camera moves) and on
      // the very first update it is computed from the origin, which puts the
      // whole cascade somewhere else entirely. `_rot` is already exactly the
      // rotation lookAt would produce for an eye on +L looking at the centre,
      // and reusing it also guarantees the camera basis matches the basis the
      // texel snapping above used — they must not be allowed to drift apart.
      cam.quaternion.setFromRotationMatrix(this._rot);
      cam.updateMatrix();
      cam.updateMatrixWorld(true);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

      c.matrix.copy(this._biasMat);
      c.matrix.multiply(cam.projectionMatrix);
      c.matrix.multiply(cam.matrixWorldInverse);
      c.matrix.multiply(this._originMat);          // varying is origin-relative
      this.uniforms.uCsmMatrix.value[i].copy(c.matrix);

      const normalOffset = this.opts.normalOffsetTexels * texel;
      const depthBias = this.opts.depthBiasTexels * texel;
      this.uniforms.uCsmParams.value[i].set(texel, depthRange, normalOffset, depthBias);

      // Re-render this cascade if it moved or resized, or on its stagger interval.
      const moved = this._center.distanceToSquared(c.lastCentre) > (texel * texel * 0.25)
        || c.lastKey !== fitKey;
      let due;
      if (cacheOn) {
        // PERF (static cache): the fit is texel-snapped and the matrix is a
        // pure function of (centre, extents, light direction), so an unmoved
        // cascade over unchanged casters would redraw the same depth texels.
        // Redraw only on a move, a light turn, markDirty(), or a caster change
        // (_casterSig), plus a slow safety refresh.
        due = casterDirty || c.lastFrame < -900 || !c.lastDir.equals(L)
          || (this._frame - c.lastFrame) >= (this._casterLowRate ? this.opts.lowRateRefresh : this.opts.staticRefresh);
      } else {
        const interval = (i === 0) ? 1 : this.opts.farCascadeInterval;
        due = (this._frame - c.lastFrame) >= interval;
      }
      if (moved || due) {
        c.lastCentre.copy(this._center);
        c.lastKey = fitKey;
        c.lastFrame = this._frame;
        c.lastDir.copy(L);
        anyDirty.push(i);
      }
    }

    // ---- split bands (partition of unity, no seams) -------------------------
    for (let i = 0; i < count; i++) {
      const s = this.uniforms.uCsmSplits.value[i];
      const lenPrev = (i > 0) ? (splits[i] - splits[i - 1]) : 0;
      const lenCur = splits[i + 1] - splits[i];
      const lenNext = (i + 1 < count) ? (splits[i + 2] - splits[i + 1]) : 0;
      const hIn = (i > 0) ? 0.07 * Math.min(lenPrev, lenCur) : 0;
      const hOut = (i + 1 < count) ? 0.07 * Math.min(lenCur, lenNext) : 0;
      // Cascade 0 has no fade-in band. -1e6 (not -2) so ortho view depths,
      // which can be negative, still land in it.
      const inA = (i > 0) ? splits[i] - hIn : -1e6;
      const inB = (i > 0) ? splits[i] + hIn : -1e6 + 1;
      const outA = (i + 1 < count) ? splits[i + 1] - hOut : 1e9;
      const outB = (i + 1 < count) ? splits[i + 1] + hOut : 1e9;
      s.set(inA, inB, outA, outB);
    }
    for (let i = count; i < CSM_MAX_CASCADES; i++) {
      this.uniforms.uCsmSplits.value[i].set(1e9, 1e9 + 1, 1e9, 1e9);
    }
    this.uniforms.uCsmMisc.value.z = ortho ? near + (far - near) * 0.86 : far * 0.86;
    this.uniforms.uCsmMisc.value.w = far;
    if (isoFit) { this.uniforms.uCsmMisc.value.z = 1e6; this.uniforms.uCsmMisc.value.w = 1e6 + 1; }
    this.uniforms.uCsmCount.value = effCount;

    if (anyDirty.length === 0) {
      // A depth pass READS the fill lights (three's setupLights), and those
      // reads are what resolve the lazy skylight grade / key floor
      // (_installSkylightGrade) between this update and engine.js writing the
      // sky's colours back. A skipped pass must make the same reads, or the
      // fill colours alternate frame to frame (measured: the static cache
      // flipped hemi/ambient every frame until this was added).
      this._touchLightState();
      return;
    }

    // ---- render the depth passes -------------------------------------------
    const scene = this.scene;
    const prevTarget = renderer.getRenderTarget();
    const prevActiveCube = renderer.getActiveCubeFace();
    const prevActiveMip = renderer.getActiveMipmapLevel();
    const prevAutoClear = renderer.autoClear;
    const prevShadowEnabled = renderer.shadowMap.enabled;
    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevClear = renderer.getClearColor(this._colB).getHex();
    const prevAlpha = renderer.getClearAlpha();

    this._hideNonCasters(scene);

    try {
      renderer.shadowMap.enabled = false;
      renderer.autoClear = false;
      scene.background = null;
      scene.overrideMaterial = this._depthMat;
      // White == packed depth 1.0 == "nothing here". Clearing to black would
      // unpack to 255/256 and shadow anything at the very back of the range.
      renderer.setClearColor(0xffffff, 1);

      const rt = this._atlas;
      if (!this._atlasCleared) {
        this._atlasCleared = true;
        rt.scissorTest = false;
        rt.viewport.set(0, 0, rt.width, rt.height);
        renderer.setRenderTarget(rt);
        renderer.clear(true, true, false);
      }
      // Clear only the tiles we are about to redraw (scissored).
      for (let k = 0; k < anyDirty.length; k++) {
        const i = anyDirty[k];
        const r = this._tileRect(i);
        rt.viewport.set(r[0], r[1], r[2], r[3]);
        rt.scissor.set(r[0], r[1], r[2], r[3]);
        rt.scissorTest = true;
        renderer.setRenderTarget(rt);
        renderer.clear(true, true, false);
        renderer.render(scene, this._cascades[i].cam);
      }
      rt.scissorTest = false;
    } finally {
      this._restoreNonCasters();
      scene.overrideMaterial = prevOverride;
      scene.background = prevBackground;
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.enabled = prevShadowEnabled;
      renderer.setRenderTarget(prevTarget, prevActiveCube, prevActiveMip);
    }
  }

  // -------------------------------------------------------------------------
  // Internals — world-space AO height volume
  // -------------------------------------------------------------------------

  _applyAoParams() {
    const o = this.opts;
    const q = QUALITY[this._quality];
    const taps = (o.worldAO === false) ? 0 : (q.aoTaps | 0);
    const u = this.uniforms;
    u.uAoParams.value.x = clamp(o.aoIndirect, 0, 1);
    u.uAoParams.value.y = clamp(o.aoDirect, 0, 1);
    // .z (taps) is only switched on once a height volume has been rendered.
    this._aoTaps = taps;
    if (!taps || !this._aoTarget) u.uAoParams.value.z = 0;
    else u.uAoParams.value.z = taps;
    u.uAoTune.value.y = Math.max(0.01, o.aoHeightTol);
    u.uAoTune.value.w = clamp(o.aoFillSaturation, 0, 1);
    u.uAoShape.value.set(Math.max(0.1, o.aoPower), Math.max(0.02, o.aoContact),
      Math.max(0.1, o.aoGradHeight), clamp(o.aoGradDepth, 0, 0.9));
    u.uAoCover.value.set(clamp(o.aoCover, 0, 1), clamp(o.aoCrease, 0, 1),
      Math.max(0.02, o.aoCreaseDist), clamp(o.aoGap, 0, 1));
    u.uAoGrad.value.set(clamp(o.aoWallGrad || 0, 0, 0.9), Math.max(0.2, o.aoWallGradPow || 1),
      clamp(o.aoFillFloor || 0, 0, 0.95), clamp(o.aoFillKnee != null ? o.aoFillKnee : 0.15, 0.01, 0.5));
    const aoSig = [o.aoRadius, o.aoTight, o.aoBroad, o.aoBroadRadius].join(',');
    if (this._aoSig !== aoSig) { this._aoSig = aoSig; this._aoState.S = 0; }
    if (q.aoRes && q.aoRes !== this._aoRes) this._aoState.S = 0;   // force a re-render
  }

  /**
   * Keep the AO height volume over what the camera sees. Re-rendered only when
   * the view leaves the region / changes scale, or when the static scene
   * changes (a cheap transform signature, checked every 15 frames) — it is one
   * extra scene pass, not a per-frame cost.
   */
  _aoUpdate(camera) {
    const u = this.uniforms;
    const q = QUALITY[this._quality];
    if (!this._aoTaps || !q.aoRes || !camera || !this.renderer) {
      u.uAoParams.value.z = 0;
      return;
    }
    const st = this._aoState;
    // Ground footprint of the view: the four frustum corners hit y = 0.
    camera.updateMatrixWorld();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const c = this._aoCorner, d = this._aoDir;
    for (let i = 0; i < 4; i++) {
      const nx = (i & 1) ? 1 : -1, ny = (i & 2) ? 1 : -1;
      c.set(nx, ny, -1).unproject(camera);
      d.set(nx, ny, 1).unproject(camera).sub(c);
      let t = (Math.abs(d.y) > 1e-6) ? -c.y / d.y : 0;
      if (!(t > 0)) t = 0;
      const x = c.x + d.x * Math.min(t, 1.0), z = c.z + d.z * Math.min(t, 1.0);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const R = Math.max(0.1, this.opts.aoRadius);
    let ext = Math.max(maxX - minX, maxZ - minZ);
    if (!isFinite(ext)) return;
    // Coarse log steps so a zoom ease does not re-render every frame.
    ext = clamp(ext * 1.3 + 4 * R, 48, 900);
    const S = 48 * Math.pow(1.25, Math.ceil(Math.log(ext / 48) / Math.log(1.25)));
    const cx = (minX + maxX) * 0.5, cz = (minZ + maxZ) * 0.5;

    let dirty = (S !== st.S) || Math.abs(cx - st.cx) > S / 12 || Math.abs(cz - st.cz) > S / 12;
    if (!dirty && this._frame - st.sigFrame >= 15) {
      st.sigFrame = this._frame;
      const sig = this._aoSignature();
      if (sig !== st.sig) dirty = true;
    }
    if (dirty) {
      const grid = S / 32;
      st.S = S;
      st.cx = Math.round(cx / grid) * grid;
      st.cz = Math.round(cz / grid) * grid;
      st.sig = this._aoSignature();
      st.sigFrame = this._frame;
      this._aoRender(q.aoRes);
    }
    if (!this._aoTarget) { u.uAoParams.value.z = 0; return; }
    // Surface offset must clear the bilinear ramp of the height map (~1 texel),
    // or every wall would sample its own roof edge and occlude itself.
    const texel = st.S / this._aoRes;
    u.uAoTune.value.x = texel;
    u.uAoTune.value.z = 1 / this._aoRes;
    // uv: u = (x - (cx - S/2)) / S ; v = ((cz + S/2) - z) / S  (camera up = -Z)
    u.uAoXf.value.set(1 / st.S, -(st.cx - st.S / 2) / st.S, -1 / st.S, (st.cz + st.S / 2) / st.S);
    u.uAoParams.value.z = this._aoTaps;
    u.uAoParams.value.w = 0.04;
  }

  _aoSignature() {
    let sig = 0;
    this.scene.traverse((o) => {
      if (!o.isMesh || !o.visible || !(o.castShadow || o.receiveShadow)) return;
      const e = o.matrixWorld.elements;
      sig += (o.id % 997) * 0.013 + e[12] * 1.7 + e[13] * 3.1 + e[14] * 0.37 + e[5] * 5.3
        + (o.geometry ? o.geometry.id * 0.77 : 0) + (o.isInstancedMesh ? o.count * 0.19 : 0);
    });
    return Math.round(sig * 1000);
  }

  _aoRender(res) {
    const renderer = this.renderer;
    const st = this._aoState;
    if (!this._aoTarget || this._aoRes !== res) {
      if (this._aoTarget) this._aoTarget.dispose();
      if (this._aoTargetB) this._aoTargetB.dispose();
      const mk = (name) => {
        const t = new THREE.WebGLRenderTarget(res, res, {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: false,
          stencilBuffer: false,
          generateMipmaps: false,
        });
        t.texture.name = name;
        return t;
      };
      this._aoTarget = mk('CSM.aoHeightA');
      this._aoTargetB = mk('CSM.aoHeightB');
      this._aoRes = res;
    }
    const cam = this._aoCam;
    const h = st.S * 0.5;
    const top = (this.opts.maxCasterHeight || 80) + 40;
    cam.left = -h; cam.right = h; cam.top = h; cam.bottom = -h;
    cam.near = 1; cam.far = top + 60;
    cam.position.set(st.cx, top, st.cz);
    cam.lookAt(st.cx, 0, st.cz);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    const scene = this.scene;
    const prevTarget = renderer.getRenderTarget();
    const prevActiveCube = renderer.getActiveCubeFace();
    const prevActiveMip = renderer.getActiveMipmapLevel();
    const prevAutoClear = renderer.autoClear;
    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevClear = renderer.getClearColor(this._colB).getHex();
    const prevAlpha = renderer.getClearAlpha();
    const prevShadow = renderer.shadowMap.enabled;
    // Static, opaque world only: dynamics (cars, people, clouds, the ghost)
    // are flagged neither castShadow nor receiveShadow; transparent overlays
    // (light pools, glows, precipitation) must not become "solid".
    const hidden = this._aoHidden;
    hidden.length = 0;
    const swapped = this._aoSwapped || (this._aoSwapped = []);
    swapped.length = 0;
    scene.traverse((o) => {
      if (!o.visible) return;
      if (o.isMesh || o.isLine || o.isPoints || o.isSprite) {
        const m = o.material;
        const transp = m && !Array.isArray(m) && m.transparent && !m.depthWrite;
        if (!o.isMesh || !(o.castShadow || o.receiveShadow) || transp || o.userData.noWorldAO) { o.visible = false; hidden.push(o); }   // noWorldAO: props tree canopies (veg w4)
        else if (o.userData.casterGeometry) this._swapCaster(o, swapped);
      }
    });
    try {
      renderer.shadowMap.enabled = false;
      renderer.autoClear = false;
      scene.background = null;
      scene.overrideMaterial = this._aoMat;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this._aoTarget);
      renderer.clear(true, false, false);
      renderer.render(scene, cam);
      // Floor under each column's underside (AO_FLOOR_FRAG): copy A -> B, then
      // a second MAX-blended scene pass into B's alpha that reads A.
      const cm = this._aoCopyMat;
      this._aoQuad.material = cm;
      cm.uniforms.tSrc.value = this._aoTarget.texture;
      cm.uniforms.uTexel.value.set(1 / res, 1 / res);
      renderer.setRenderTarget(this._aoTargetB);
      renderer.render(this._aoQuadScene, cam);
      cm.uniforms.tSrc.value = null;
      const flm = this._aoFloorMat;
      flm.uniforms.tSrc.value = this._aoTarget.texture;
      flm.uniforms.uTexel.value.set(1 / res, 1 / res);
      scene.overrideMaterial = flm;
      renderer.render(scene, cam);
      flm.uniforms.tSrc.value = null;
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
      hidden.length = 0;
      this._unswapCasters(swapped);
      scene.overrideMaterial = prevOverride;
      // Flood "exposed" in from open air (see AO_FLOOD_FRAG): init + N steps.
      const fm = this._aoFloodMat;
      this._aoQuad.material = fm;
      fm.uniforms.uTexel.value.set(1 / res, 1 / res);
      const texel = st.S / res;
      const steps = clamp(Math.ceil(Math.max(0, this.opts.aoFloodWorld) / texel), 2, 32);
      let src = this._aoTargetB, dst = this._aoTarget;
      for (let i = 0; i <= steps; i++) {
        fm.uniforms.uInit.value = (i === 0) ? 1 : 0;
        fm.uniforms.tSrc.value = src.texture;
        renderer.setRenderTarget(dst);
        renderer.render(this._aoQuadScene, cam);
        const t = src; src = dst; dst = t;
      }
      fm.uniforms.tSrc.value = null;
      // Ground AO into B (map space), then a height-aware blur, H then V.
      const quad = this._aoQuad;
      const pass = (mat) => {
        quad.material = mat;
        mat.uniforms.tSrc.value = src.texture;
        mat.uniforms.uTexel.value.set(1 / res, 1 / res);
        renderer.setRenderTarget(dst);
        renderer.render(this._aoQuadScene, cam);
        mat.uniforms.tSrc.value = null;
        const t = src; src = dst; dst = t;
      };
      const gm = this._aoGroundMat;
      gm.uniforms.uP.value.set(Math.max(0.2, this.opts.aoRadius), texel, (res >= 2048) ? 8 : 6, clamp(this.opts.aoTight || 0, 0, 1));
      gm.uniforms.uP2.value.set(Math.max(1, this.opts.aoBroadRadius || 4), clamp(this.opts.aoBroad || 0, 0, 1), 0, 0);
      pass(gm);
      this._aoBlurMat.uniforms.uDir.value.set(1, 0);
      pass(this._aoBlurMat);
      this._aoBlurMat.uniforms.uDir.value.set(0, 1);
      pass(this._aoBlurMat);
      quad.material = this._aoFloodMat;
      this.uniforms.uAoMap.value = src.texture;
    } finally {
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
      hidden.length = 0;
      this._unswapCasters(swapped);
      scene.overrideMaterial = prevOverride;
      scene.background = prevBackground;
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.enabled = prevShadow;
      renderer.setRenderTarget(prevTarget, prevActiveCube, prevActiveMip);
    }
  }

  _touchLightState() {
    let t = 0;
    t += this.hemi.color.r + this.hemi.color.g + this.hemi.color.b + this.hemi.intensity;
    t += this.hemi.groundColor.r + this.hemi.groundColor.g + this.hemi.groundColor.b;
    t += this.ambient.color.r + this.ambient.color.g + this.ambient.color.b + this.ambient.intensity;
    t += this.sun.position.x + this.sun.position.y + this.sun.position.z;
    t += this.sun.color.r + this.sun.color.g + this.sun.color.b + this.sun.intensity;
    return t;
  }

  // PERF: signature of everything the depth pass would draw — visible caster
  // meshes, their (caster) geometry and its attribute versions, local
  // transforms, instance counts / matrix versions. Any change re-renders the
  // cascades (see cacheStatic). Local transforms suffice: nested casters
  // (building parts) move with a parent whose own transform is hashed.
  _casterSig(scene) {
    let h = 0, lowRate = false;
    const mix = (v) => { h = (h * 31 + (v * 1000 | 0)) | 0; };
    const walk = (o) => {
      if (!o.visible) return;
      if (o.isMesh && o.castShadow === true) {
        const g = o.userData.casterGeometry || o.geometry;
        mix(o.id); mix(g ? g.id : 0);
        if (g) {
          const pa = g.attributes.position;
          if (pa) mix(pa.version);
          if (g.index) mix(g.index.version);
          mix(g.drawRange.start); mix(g.drawRange.count === Infinity ? -1 : g.drawRange.count);
        }
        const p = o.position, sc = o.scale, q = o.quaternion;
        mix(p.x); mix(p.y); mix(p.z); mix(sc.x); mix(sc.y); mix(sc.z); mix(q.x); mix(q.y); mix(q.z); mix(q.w);
        if (o.isInstancedMesh) { mix(o.count); if (!o.userData.shadowLowRate) mix(o.instanceMatrix.version); }
        if (o.userData.shadowLowRate) lowRate = true;
      } else if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) {
        const p = o.position;   // containers (groups) only: movers never cast
        mix(p.x); mix(p.y); mix(p.z);
      }
      const k = o.children;
      for (let i = 0; i < k.length; i++) walk(k[i]);
    };
    walk(scene);
    this._casterLowRate = lowRate;
    return h;
  }

  _hideNonCasters(scene) {
    const hidden = this._hidden;
    hidden.length = 0;
    const sw = this._swapped || (this._swapped = []);
    sw.length = 0;
    scene.traverse((o) => {
      if (!o.visible) return;
      if (o.isMesh || o.isLine || o.isPoints || o.isSprite) {
        if (o.castShadow !== true) { o.visible = false; hidden.push(o); }
        else if (o.userData.casterGeometry) this._swapCaster(o, sw);
      }
    });
  }

  // PERF: a mesh drawn with a reduced scene-pass geometry (engine.js
  // _getViewGeometry: no -Y / sealed-interior faces) names its full geometry
  // in userData.casterGeometry. The depth and world-AO passes need those faces
  // (back-face casting, undersides), so they render the full one.
  _swapCaster(o, list) {
    const g = o.userData.casterGeometry;
    if (!g || g === o.geometry) return;
    list.push(o, o.geometry);
    o.geometry = g;
  }

  _unswapCasters(list) {
    for (let i = 0; i < list.length; i += 2) list[i].geometry = list[i + 1];
    list.length = 0;
  }

  _restoreNonCasters() {
    const hidden = this._hidden;
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
    hidden.length = 0;
    if (this._swapped) this._unswapCasters(this._swapped);
  }

  // -------------------------------------------------------------------------
  // Internals — night light pools
  // -------------------------------------------------------------------------

  _updatePools(nightT) {
    // Pools ramp in as the sun drops; fully on by deep dusk.
    const amt = smoothstep(0.42, 0.68, nightT);
    this._nightAmt = amt;
    this._poolUniforms.uNight.value = amt;
    this._poolUniforms.uTime.value = this._time;
    if (this._poolMesh) this._poolMesh.visible = amt > 0.004;
    if (this._glowMesh) this._glowMesh.visible = amt > 0.004;
  }

  _rebuildPools() {
    const list = this._lampAnchors;
    const n = list.length;
    if (n === 0) {
      if (this._poolMesh) this._poolMesh.count = 0;
      this._rebuildGlows();
      return;
    }
    if (!this._poolMesh || this._poolCap < n) {
      if (this._poolMesh) this._disposeInstanced(this._poolMesh);
      this._poolCap = Math.max(64, nextPow2(n));
      const geo = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.ShaderMaterial({
        uniforms: this._poolUniforms,
        vertexShader: POOL_VERT,
        fragmentShader: POOL_FRAG,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        fog: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, this._poolCap);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 3;
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(this._poolCap * 3), 3));
      geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(new Float32Array(this._poolCap * 3), 3));
      this._poolMesh = mesh;
      this.scene.add(mesh);
    }
    this._fillInstances(this._poolMesh, list, this.opts.lampRadius, this.opts.lampIntensity, this.opts.lampColor, 0.03, false);
    this._rebuildGlows();
  }

  _rebuildGlows() {
    const lamps = this._lampAnchors;
    const wins = this.opts.windowGlowBillboards ? this._windowGlows : [];
    const total = lamps.length + wins.length;
    if (total === 0) {
      if (this._glowMesh) this._glowMesh.count = 0;
      return;
    }
    if (!this._glowMesh || this._glowCap < total) {
      if (this._glowMesh) this._disposeInstanced(this._glowMesh);
      this._glowCap = Math.max(64, nextPow2(total));
      const geo = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.ShaderMaterial({
        uniforms: this._poolUniforms,
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        fog: false,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, this._glowCap);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 4;
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(this._glowCap * 3), 3));
      geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(new Float32Array(this._glowCap * 3), 3));
      this._glowMesh = mesh;
      this.scene.add(mesh);
    }

    const mesh = this._glowMesh;
    const tint = mesh.geometry.getAttribute('aTint');
    const param = mesh.geometry.getAttribute('aParam');
    const m = new THREE.Matrix4();
    const col = this._colA;
    let k = 0;
    for (let i = 0; i < lamps.length; i++, k++) {
      const a = lamps[i];
      const y = (a.bulbY !== undefined) ? a.bulbY : ((a.y || 0) + 4.2);
      m.makeTranslation(a.x || 0, y, a.z || 0);
      mesh.setMatrixAt(k, m);
      col.setHex(a.color !== undefined ? a.color : this.opts.lampColor, THREE.SRGBColorSpace);
      tint.setXYZ(k, col.r, col.g, col.b);
      param.setXYZ(k, (a.glowRadius || this.opts.lampGlowRadius || 1.5),
        (a.intensity !== undefined ? a.intensity : 1) * (this.opts.lampGlowIntensity != null ? this.opts.lampGlowIntensity : 0.8), (i % 97) / 97);
    }
    for (let i = 0; i < wins.length; i++, k++) {
      const a = wins[i];
      m.makeTranslation(a.x || 0, a.y || 0, a.z || 0);
      mesh.setMatrixAt(k, m);
      col.setHex(a.color !== undefined ? a.color : 0xffd9a0, THREE.SRGBColorSpace);
      tint.setXYZ(k, col.r, col.g, col.b);
      param.setXYZ(k, (a.radius || 1.8), (a.intensity !== undefined ? a.intensity : 0.7), (i % 89) / 89);
    }
    mesh.count = k;
    mesh.instanceMatrix.needsUpdate = true;
    tint.needsUpdate = true;
    param.needsUpdate = true;
  }

  _fillInstances(mesh, list, defRadius, defIntensity, defColor, yOffset) {
    const tint = mesh.geometry.getAttribute('aTint');
    const param = mesh.geometry.getAttribute('aParam');
    const m = new THREE.Matrix4();
    const col = this._colA;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      m.makeTranslation(a.x || 0, (a.y || 0) + yOffset, a.z || 0);
      mesh.setMatrixAt(i, m);
      col.setHex(a.color !== undefined ? a.color : defColor, THREE.SRGBColorSpace);
      // night w4r6 (critic w4r5: "the lamp pools are identical evenly spaced
      // ovals that read as a stamped pattern"): each lamp gets its own size,
      // strength and bulb (amber sodium .. warm white), hashed on its position
      // so it is stable across rebuilds. opts.lampVary = [radius +/-, intensity
      // +/-, share pulled to warm white]; [0,0,0] restores the stamped pools.
      let rK = 1, iK = 1;
      const lv = this.opts.lampVary;
      if (lv && a.color === undefined) {
        const h1 = _lampHash(a.x || 0, a.z || 0, 1.7), h2 = _lampHash(a.x || 0, a.z || 0, 5.3), h3 = _lampHash(a.x || 0, a.z || 0, 9.1);
        rK = 1 + (lv[0] || 0) * (h1 * 2 - 1);
        iK = 1 + (lv[1] || 0) * (h2 * 2 - 1);
        if (h3 < (lv[2] || 0)) col.lerp(this._colB.setHex(0xffe6c0, THREE.SRGBColorSpace), 0.55 + 0.45 * (h3 / lv[2]));
      }
      tint.setXYZ(i, col.r, col.g, col.b);
      param.setXYZ(i, (a.radius || defRadius) * rK, (a.intensity !== undefined ? a.intensity : defIntensity) * iK, (i % 101) / 101);
    }
    mesh.count = list.length;
    mesh.instanceMatrix.needsUpdate = true;
    tint.needsUpdate = true;
    param.needsUpdate = true;
  }

  _disposeInstanced(mesh) {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    mesh.dispose();
  }

  // -------------------------------------------------------------------------

  selfTest() { return selfTest(this.renderer, this); }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

function mkVec4Array(n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(new THREE.Vector4());
  return a;
}

function mkMat4Array(n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(new THREE.Matrix4());
  return a;
}

const _gradeOut = {
  sun: new THREE.Color(), sky: new THREE.Color(), gnd: new THREE.Color(),
  amb: new THREE.Color(), si: 1, ai: 0.3, hi: 0.6,
};

function gradeAt(t) {
  t = clamp(t, 0, 1);
  let i = 0;
  while (i < GRADE_C.length - 2 && GRADE_C[i + 1].t < t) i++;
  const a = GRADE_C[i], b = GRADE_C[i + 1];
  const k = clamp((t - a.t) / ((b.t - a.t) || 1e-6), 0, 1);
  _gradeOut.sun.copy(a.sun).lerp(b.sun, k);
  _gradeOut.sky.copy(a.sky).lerp(b.sky, k);
  _gradeOut.gnd.copy(a.gnd).lerp(b.gnd, k);
  _gradeOut.amb.copy(a.amb).lerp(b.amb, k);
  _gradeOut.si = a.si + (b.si - a.si) * k;
  _gradeOut.ai = a.ai + (b.ai - a.ai) * k;
  _gradeOut.hi = a.hi + (b.hi - a.hi) * k;
  return _gradeOut;
}

// ---------------------------------------------------------------------------
// selfTest — CONTRACTS-RENDER.md §4
// ---------------------------------------------------------------------------

// The readability margin. A shadowed receiver must be at least this much
// darker than the same receiver unshadowed, measured in LINEAR light. This is
// the number that was silently failing: every structural check passed while the
// on-screen contrast was ~0. Do not lower it to make a build go green.
const E2E_MIN_CONTRAST = 0.30;

/**
 * End-to-end shadow assertion (CONTRACTS-RENDER.md §4).
 *
 * Renders a KNOWN caster over a KNOWN receiver into an offscreen target, twice
 * — once with the cascade lookup live, once with `uCsmCount = 0` — and asserts
 * that the receiver actually goes darker where the caster's shadow analytically
 * lands, by at least `E2E_MIN_CONTRAST`.
 *
 * Why it is built this way:
 *  - It samples the ground at the *analytically projected* shadow centre, so a
 *    broken cascade matrix / atlas rect / UV mapping fails it, not just a
 *    missing shadow.
 *  - It also samples a point that must stay LIT, so "everything is in shadow"
 *    (the failure this rig actually had at dusk) fails too.
 *  - It runs with a real PMREM environment and a high `envMapIntensity`,
 *    because the shipped defect was that image-based lighting bypassed the
 *    shadow entirely. Without an env map in the fixture, that bug is invisible.
 */
function _e2eShadowTest(renderer, fail, ok) {
  const created = [];
  const prevTarget = renderer.getRenderTarget();
  let pmrem = null;
  try {
    const SIZE = 256;
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(40, 1, 1, 2000);
    cam.position.set(0, 210, 62);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();

    // Exposure/albedo are chosen so the LIT reference lands mid-range: if the
    // receiver clips at 255 the measured contrast is silently compressed and
    // the assertion stops meaning anything. `_e2eClipped` re-checks that below.
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xd6d6d6, roughness: 0.85, metalness: 0.0,
    });
    const groundGeo = new THREE.PlaneGeometry(240, 240);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.castShadow = false;
    scene.add(ground);

    const boxGeo = new THREE.BoxGeometry(20, 20, 20);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x808080 });
    const box = new THREE.Mesh(boxGeo, boxMat);
    box.position.set(0, 22, 0);
    box.castShadow = true;
    scene.add(box);
    created.push(groundGeo, groundMat, boxGeo, boxMat);

    // A real (if trivial) IBL, so the env path is under test too.
    let envTex = null;
    try {
      // 128x64 is not arbitrary: PMREMGenerator sizes its cube-UV chain as
      // `image.width / 4`, so a token 16x8 source produces a 4px chain whose
      // textureCubeUV() lookup returns zero — the fixture would then look like
      // it had an environment while contributing no light at all.
      const EW = 128, EH = 64;
      const data = new Uint8Array(EW * EH * 4);
      for (let i = 0; i < EW * EH; i++) {
        data[i * 4] = 170; data[i * 4 + 1] = 200; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
      }
      const eq = new THREE.DataTexture(data, EW, EH, THREE.RGBAFormat);
      eq.minFilter = THREE.LinearFilter;
      eq.magFilter = THREE.LinearFilter;
      eq.mapping = THREE.EquirectangularReflectionMapping;
      eq.colorSpace = THREE.SRGBColorSpace;
      eq.needsUpdate = true;
      pmrem = new THREE.PMREMGenerator(renderer);
      envTex = pmrem.fromEquirectangular(eq).texture;
      eq.dispose();
      groundMat.envMapIntensity = 0.8;
    } catch (e) { /* IBL is a bonus; the direct/ambient assertions still run */ }

    const rig = new LightingRig(renderer, scene, cam, {
      quality: 2, sunSource: 'external', mapCenter: new THREE.Vector3(0, 0, 0),
      mapSize: 240, maxCasterHeight: 48, minShadowDistance: 260, exposure: 0.50,
    });
    if (envTex) rig.setEnvironment(envTex);
    rig.patchMaterial(groundMat);

    const L = new THREE.Vector3(0.45, 0.72, 0.53).normalize();
    rig.setSunDirection(L);

    const rt = new THREE.WebGLRenderTarget(SIZE, SIZE, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      type: THREE.UnsignedByteType, depthBuffer: true,
    });

    // Where the box centre's shadow lands on y = 0, and a point that cannot be
    // shadowed by anything. Both must be inside the frame and unoccluded.
    const pShadow = new THREE.Vector3(
      -L.x * (22 / L.y), 0.02, -L.z * (22 / L.y)
    );
    const pLit = new THREE.Vector3(52, 0.02, 52);

    const buf = new Uint8Array(SIZE * SIZE * 4);
    const shot = (csmOn) => {
      rig.markDirty();
      rig.update(0.016, { camera: cam, nightT: 0.0, sunDir: L, quality: 2 });
      if (!csmOn) rig.uniforms.uCsmCount.value = 0;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, true, true);
      renderer.render(scene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, buf);
      return buf.slice();
    };
    const withCsm = shot(true);
    const noCsm = shot(false);

    const sampleAt = (px, p) => {
      const v = p.clone().project(cam);
      const x = Math.round((v.x * 0.5 + 0.5) * (SIZE - 1));
      const y = Math.round((v.y * 0.5 + 0.5) * (SIZE - 1));
      if (x < 2 || y < 2 || x > SIZE - 3 || y > SIZE - 3) return null;
      let s = 0, n = 0;                            // 3x3 so one stray texel cannot decide it
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = ((y + dy) * SIZE + (x + dx)) * 4;
          s += px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
          n++;
        }
      }
      return s / n;
    };

    const sh = sampleAt(withCsm, pShadow);
    const li = sampleAt(withCsm, pLit);
    const shRef = sampleAt(noCsm, pShadow);
    const liRef = sampleAt(noCsm, pLit);

    if (sh === null || li === null) {
      fail('e2e: probe points fell outside the test frame');
    } else if (!(liRef > 45)) {
      fail('e2e: the unshadowed receiver never lit up (value ' + liRef.toFixed(1) +
        ') — too dark to measure a contrast honestly. Raise the fixture exposure.');
    } else if (shRef > 248 || liRef > 248) {
      fail('e2e: fixture is over-exposed (' + shRef.toFixed(0) + '/' + liRef.toFixed(0) +
        ') — clipping would hide a weak shadow. Lower the fixture exposure.');
    } else {
      // 1. the caster's shadow must actually darken the receiver where it lands
      const drop = 1 - sh / Math.max(shRef, 1e-3);
      if (drop < E2E_MIN_CONTRAST) {
        fail('e2e: receiver only lost ' + (drop * 100).toFixed(1) +
          '% of its light inside the shadow (need >= ' + (E2E_MIN_CONTRAST * 100) +
          '%). Shadows are being computed but are not readable.');
      } else {
        ok('e2e: receiver loses ' + (drop * 100).toFixed(1) + '% of its light in shadow' +
          ' (' + shRef.toFixed(0) + ' -> ' + sh.toFixed(0) + ', lit reference ' + liRef.toFixed(0) + ')');
      }

      // 2. the shadow must be LOCAL — a point away from the caster stays lit.
      const litDrop = 1 - li / Math.max(liRef, 1e-3);
      if (litDrop > 0.08) {
        fail('e2e: a point with no caster above it also darkened by ' +
          (litDrop * 100).toFixed(1) + '% — the whole scene is being shadowed');
      } else {
        ok('e2e: unoccluded receiver stays lit (delta ' + (litDrop * 100).toFixed(1) + '%)');
      }

      // 3. contrast between the two points in the SAME frame — this is what a
      //    player actually sees, and it is the number the old rig failed.
      const seen = 1 - sh / Math.max(li, 1e-3);
      if (seen < E2E_MIN_CONTRAST) {
        fail('e2e: on-screen shadow/lit contrast is only ' + (seen * 100).toFixed(1) +
          '% (need >= ' + (E2E_MIN_CONTRAST * 100) + '%)');
      } else {
        ok('e2e: on-screen shadow/lit contrast ' + (seen * 100).toFixed(1) + '%');
      }

      // 4. and it must not be a black hole — kid-friendly art direction.
      if (sh < li * 0.06) {
        fail('e2e: shadow crushed to black (' + sh.toFixed(1) + ' vs lit ' + li.toFixed(1) + ')');
      }
    }

    rig.dispose();
    rt.dispose();
  } catch (e) {
    fail('e2e threw: ' + (e && e.message ? e.message : e));
  } finally {
    for (const d of created) { try { d.dispose(); } catch (e) { /* ignore */ } }
    if (pmrem) { try { pmrem.dispose(); } catch (e) { /* ignore */ } }
    try { renderer.setRenderTarget(prevTarget); } catch (e) { /* ignore */ }
  }
}

/**
 * `selfTest(renderer?, rig?)` -> `{ pass, notes }`.
 * With no renderer it runs pure-math assertions (split scheme, texel snapping
 * stability, grade table monotonicity, shader-string integrity). With a
 * renderer it additionally compiles a patched material and cycles quality +
 * cascade counts 100x looking for target leaks.
 */
export function selfTest(renderer, existingRig) {
  const notes = [];
  let pass = true;
  const fail = (m) => { pass = false; notes.push('FAIL: ' + m); };
  const ok = (m) => notes.push('ok: ' + m);

  // --- shader string integrity -------------------------------------------
  try {
    const chunk = csmLightsFragmentBegin();
    if (chunk.indexOf('csmApply(') < 0) fail('lights_fragment_begin hook not injected');
    else ok('lights_fragment_begin hook injected once');
    const n = (chunk.match(/csmApply\(/g) || []).length;
    if (n !== 1) fail('csmApply injected ' + n + ' times (expected 1)');
    if (CSM_FRAGMENT_PARS.indexOf('uCsmMatrix') < 0) fail('fragment pars missing uCsmMatrix');
    if (CSM_FRAGMENT_PARS.indexOf('uCsmFill') < 0) fail('fragment pars missing uCsmFill');
    // The IBL splice. Without it the sky env map (the single largest light in
    // the shipping game) ignores shadows completely.
    const maps = csmLightsFragmentMaps();
    if (maps.indexOf('iblIrradiance *= csmIblScale();') < 0) fail('lights_fragment_maps IBL hook not injected');
    else ok('lights_fragment_maps IBL occlusion hook injected');
    if ((maps.match(/csmIblScale\(\)/g) || []).length !== 1) fail('csmIblScale injected more than once');
    const braces = countChar(CSM_FRAGMENT_PARS, '{') - countChar(CSM_FRAGMENT_PARS, '}');
    if (braces !== 0) fail('CSM_FRAGMENT_PARS unbalanced braces (' + braces + ')');
    else ok('CSM_FRAGMENT_PARS braces balanced');
  } catch (e) { fail('shader assembly threw: ' + e.message); }

  // --- pure math ----------------------------------------------------------
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 1, 2000);
  const rig = existingRig || new LightingRig(renderer || null, scene, cam, { quality: 2 });
  // Running against a live rig must not leave it altered.
  const savedQuality = rig.getQuality();
  const savedCascades = rig.opts.cascades;
  const savedLamps = rig._lampAnchors;
  const savedWindows = rig._windowGlows;

  try {
    const sp = rig._computeSplits(1, 900, 3, 0.86);
    if (sp.length !== 4) fail('split count wrong');
    for (let i = 1; i < sp.length; i++) {
      if (!(sp[i] > sp[i - 1])) fail('splits not monotonic at ' + i);
      if (!isFinite(sp[i])) fail('split NaN at ' + i);
    }
    ok('splits monotonic + finite: ' + sp.map((v) => v.toFixed(1)).join(', '));

    for (let t = 0; t <= 1.0001; t += 0.05) {
      const g = gradeAt(t);
      if (!isFinite(g.si) || !isFinite(g.ai) || !isFinite(g.hi)) fail('grade NaN at t=' + t);
      if (!isFinite(g.sun.r + g.sun.g + g.sun.b)) fail('grade colour NaN at t=' + t);
    }
    ok('day/night grade table finite over [0,1]');

    // Cascade stability: orbit the camera and confirm the snapped centre only
    // moves in whole texels (this is what stops shadows swimming).
    if (renderer) {
      cam.position.set(320 + 120, 90, 320 + 120);
      cam.lookAt(320, 0, 320);
      cam.updateMatrixWorld();
      rig._updateCelestial(0.2, {});
      let maxErr = 0;
      let prevTexel = null;
      for (let a = 0; a < 64; a++) {
        const ang = (a / 64) * Math.PI * 2;
        cam.position.set(320 + Math.cos(ang) * 160, 110, 320 + Math.sin(ang) * 160);
        cam.lookAt(320, 0, 320);
        cam.updateMatrixWorld();
        rig._renderCascades(cam);
        const c = rig._cascades[0];
        if (prevTexel !== null && Math.abs(c.texelWorld - prevTexel) > 1e-6) {
          fail('cascade 0 texel size changed during orbit (would cause swim)');
        }
        prevTexel = c.texelWorld;
        const inLight = c.lastCentre.clone().applyMatrix4(rig._rotInv);
        const ex = Math.abs(inLight.x / c.texelWorld - Math.round(inLight.x / c.texelWorld));
        const ey = Math.abs(inLight.y / c.texelWorld - Math.round(inLight.y / c.texelWorld));
        maxErr = Math.max(maxErr, ex, ey);
      }
      if (maxErr > 1e-3) fail('cascade centre not texel-snapped (max err ' + maxErr.toFixed(5) + ' texels)');
      else ok('cascade centres texel-snapped through a full orbit (err ' + maxErr.toExponential(1) + ')');
    }

    // Leak check.
    if (renderer) {
      const info = renderer.info.memory;
      const before = info.textures;
      for (let i = 0; i < 100; i++) {
        rig.setQuality(i % 3);
        rig.setSize(800 + (i % 7) * 40, 600, 1 + (i % 2));
      }
      rig.setQuality(2);
      const after = renderer.info.memory.textures;
      if (after - before > 4) fail('texture leak over 100 quality cycles: +' + (after - before));
      else ok('no target leak over 100 quality/resize cycles (delta ' + (after - before) + ')');
    }

    // The one that matters: does a caster actually darken a receiver on screen?
    if (renderer) _e2eShadowTest(renderer, fail, ok);

    // Uniform sanity.
    const u = rig.uniforms;
    if (u.uCsmSplits.value.length !== CSM_MAX_CASCADES) fail('uCsmSplits array size');
    if (u.uCsmMatrix.value.length !== CSM_MAX_CASCADES) fail('uCsmMatrix array size');
    for (let i = 0; i < CSM_MAX_CASCADES; i++) {
      const e = u.uCsmMatrix.value[i].elements;
      for (let j = 0; j < 16; j++) if (!isFinite(e[j])) fail('uCsmMatrix[' + i + '] NaN');
      const p = u.uCsmParams.value[i];
      if (!isFinite(p.x + p.y + p.z + p.w)) fail('uCsmParams[' + i + '] NaN');
    }
    ok('uniform arrays sized and finite');

    // Lamp pools scale check.
    const anchors = [];
    for (let i = 0; i < 400; i++) anchors.push({ x: (i % 20) * 30, z: ((i / 20) | 0) * 30 });
    rig.setLampAnchors(anchors);
    if (!rig._poolMesh || rig._poolMesh.count !== 400) fail('lamp pools did not instance 400 anchors');
    else ok('400 lamp anchors -> ' + (rig._poolMesh ? 1 : 0) + ' pool draw + ' + (rig._glowMesh ? 1 : 0) + ' glow draw');
  } catch (e) {
    fail('threw: ' + (e && e.message ? e.message : e));
  } finally {
    if (!existingRig) {
      try { rig.dispose(); } catch (e) { /* ignore */ }
    } else {
      try {
        rig.opts.cascades = savedCascades;
        rig._quality = -1;
        rig.setQuality(savedQuality);
        rig.setLampAnchors(savedLamps);
        rig.setWindowGlows(savedWindows);
      } catch (e) { notes.push('note: state restore failed: ' + e.message); }
    }
  }

  return { pass, notes };
}

function countChar(s, c) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === c) n++;
  return n;
}

export default LightingRig;
