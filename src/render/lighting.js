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
	csmDbgAtlas = csmUnpackDepth( texture2D( uCsmAtlas, uv ) );

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

// How much of the sky dome this fragment loses. 0 = full dome (lit ground, or
// open ground that is merely sun-blocked), 1 = tucked right under a caster.
float csmSkyOcclusion() {
	float sunBlocked = 1.0 - csmLastShadow;
	// uCsmSky.y is the floor: even wide-open shadowed ground loses a little sky,
	// because the caster that is blocking the sun subtends some solid angle.
	return sunBlocked * mix( uCsmSky.y, 1.0, csmLastProx );
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

// The single entry point a material splices in. Returns the direct light colour
// modulated by the cascaded shadow (and, in debug mode, the cascade tint).
vec3 csmApply( const in vec3 lightColor, const in vec3 viewNormal, const in vec3 viewLightDir ) {

	if ( uCsmCount < 0.5 ) return lightColor;

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
    '\t\t#endif'
  );
  // Second hook: occlude the indirect (hemi + ambient + probe) term by the same
  // shadow so low-sun shadows still read. See csmIndirectScale().
  if (out.indexOf(INDIRECT_SPEC_LINE) >= 0) {
    out = out.replace(
      INDIRECT_SPEC_LINE,
      '#if defined( RE_IndirectDiffuse )\n\tirradiance *= csmIndirectScale();\n#endif\n' + INDIRECT_SPEC_LINE
    );
  }
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
    '\n#if defined( RE_IndirectDiffuse )\n\tiblIrradiance *= csmIblScale();\n\tiblIrradiance *= csmIblTint();\n#endif\n' +
    '#if defined( RE_IndirectSpecular )\n\tradiance *= csmSpecularScale();\n#endif\n';
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
const QUALITY = [
  { cascades: 1, taps: 4,  search: 4,  tile: 1024, rotate: 0, bilinear: 0, farScale: 0.75 },
  { cascades: 2, taps: 5,  search: 6,  tile: 1024, rotate: 4, bilinear: 1, farScale: 0.9 },
  { cascades: 3, taps: 8,  search: 8,  tile: 1024, rotate: 0, bilinear: 1, farScale: 1.0 },
];

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
      normalOffsetTexels: 1.0,
      depthBiasTexels: 0.5,
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
      lampColor: 0xffcf8a,
      lampRadius: 9.5,
      lampIntensity: 1.0,
      // Casters render their BACK faces. Blockville's casters are closed voxel
      // shells, so the stored depth is a whole object-thickness behind the lit
      // surface and self-shadow acne simply cannot occur — which is what lets
      // the bias stay at ~1 texel instead of the ~1 world unit the old rig
      // needed. Switch to FrontSide only if you add open/single-sided casters
      // (they cast nothing under BackSide), and raise the two bias texel
      // counts to ~3.0 / ~1.5 if you do.
      casterSide: THREE.BackSide,
      rotateBlock: null,         // null => follow quality (see QUALITY[].rotate)
      farCascadeInterval: 2,     // far cascades re-render every N frames if stable
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
    if (p.lampColor !== undefined || p.lampRadius !== undefined || p.lampIntensity !== undefined) {
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
   */
  setDebugCascades(on) {
    this._debug = (on === true) ? 1 : (typeof on === 'number' ? clamp(on | 0, 0, 6) : 0);
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
    this._ensureAtlas(tile, count);
    this.markDirty();
  }

  _ensureAtlas(tile, count) {
    const grid = (count <= 1) ? 1 : 2;
    const size = tile * grid;
    if (this._atlas && this._atlasTile === tile && this._atlasGrid === grid) return;
    if (this._atlas) this._atlas.dispose();
    const rt = new THREE.WebGLRenderTarget(size, size, {
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
    this._atlasTile = tile;
    this._atlasGrid = grid;
    this._atlasCleared = false;
    this.uniforms.uCsmAtlas.value = rt.texture;
    this.uniforms.uCsmAtlasTexel.value.set(1 / size, 1 / size);

    // atlas sub-rects (2x2 layout; cascade 3 unused at 3 cascades)
    const s = 1 / grid;
    for (let i = 0; i < CSM_MAX_CASCADES; i++) {
      const gx = (grid === 1) ? 0 : (i % 2);
      const gy = (grid === 1) ? 0 : ((i / 2) | 0);
      this.uniforms.uCsmRect.value[i].set(gx * s, gy * s, s, s);
    }
  }

  _tileRect(i) {
    const t = this._atlasTile;
    const grid = this._atlasGrid;
    const gx = (grid === 1) ? 0 : (i % 2);
    const gy = (grid === 1) ? 0 : ((i / 2) | 0);
    return [gx * t, gy * t, t, t];
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
    const splits = this._computeSplits(near, far, count, this.opts.splitLambda);

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

    const tile = this._atlasTile;
    const anyDirty = [];

    for (let i = 0; i < count; i++) {
      const c = this._cascades[i];
      const n = splits[i], f = splits[i + 1];
      c.near = n; c.far = f;

      // Optimal bounding sphere of the frustum slice (rotation invariant, so
      // the fit does not change as the camera orbits => no shadow swim).
      let cz = (a2 + 1) * (n + f) * 0.5;
      let R;
      if (cz > f) { cz = f; R = f * Math.sqrt(a2); }
      else { R = Math.sqrt(f * f * a2 + (cz - f) * (cz - f)); }
      R = Math.max(R, 1);

      const texel = (2 * R) / tile;
      c.radius = R;
      c.texelWorld = texel;

      // Sphere centre in world space, then snapped to the shadow texel grid.
      this._center.copy(camPos).addScaledVector(camFwd, cz);
      this._center.applyMatrix4(this._rotInv);
      this._center.x = Math.round(this._center.x / texel) * texel;
      this._center.y = Math.round(this._center.y / texel) * texel;
      this._center.applyMatrix4(this._rot);

      const back = R + this.opts.maxCasterHeight + 8;
      const depthRange = back + R + this.opts.maxCasterHeight + 8;
      c.depthRange = depthRange;

      const cam = c.cam;
      cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
      cam.near = 0.05; cam.far = depthRange;
      cam.updateProjectionMatrix();
      cam.position.copy(this._center).addScaledVector(L, back);
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

      // Re-render this cascade if it moved, or on its stagger interval.
      const moved = this._center.distanceToSquared(c.lastCentre) > (texel * texel * 0.25);
      const interval = (i === 0) ? 1 : this.opts.farCascadeInterval;
      const due = (this._frame - c.lastFrame) >= interval;
      if (moved || due) {
        c.lastCentre.copy(this._center);
        c.lastFrame = this._frame;
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
      const inA = (i > 0) ? splits[i] - hIn : -2;
      const inB = (i > 0) ? splits[i] + hIn : -1;
      const outA = (i + 1 < count) ? splits[i + 1] - hOut : 1e9;
      const outB = (i + 1 < count) ? splits[i + 1] + hOut : 1e9;
      s.set(inA, inB, outA, outB);
    }
    for (let i = count; i < CSM_MAX_CASCADES; i++) {
      this.uniforms.uCsmSplits.value[i].set(1e9, 1e9 + 1, 1e9, 1e9);
    }
    this.uniforms.uCsmMisc.value.z = far * 0.86;
    this.uniforms.uCsmMisc.value.w = far;
    this.uniforms.uCsmCount.value = count;

    if (anyDirty.length === 0) return;

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

  _hideNonCasters(scene) {
    const hidden = this._hidden;
    hidden.length = 0;
    scene.traverse((o) => {
      if (!o.visible) return;
      if (o.isMesh || o.isLine || o.isPoints || o.isSprite) {
        if (o.castShadow !== true) { o.visible = false; hidden.push(o); }
      }
    });
  }

  _restoreNonCasters() {
    const hidden = this._hidden;
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
    hidden.length = 0;
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
    const wins = this._windowGlows;
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
      param.setXYZ(k, (a.glowRadius || 1.5), (a.intensity !== undefined ? a.intensity : 1) * 0.8, (i % 97) / 97);
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
      tint.setXYZ(i, col.r, col.g, col.b);
      param.setXYZ(i, (a.radius || defRadius), (a.intensity !== undefined ? a.intensity : defIntensity), (i % 101) / 101);
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
