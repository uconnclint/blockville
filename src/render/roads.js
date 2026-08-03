// src/render/roads.js — CONTRACTS-RENDER.md §3.5
//
// Everything road: asphalt surface, connectivity-driven lane markings, raised
// concrete sidewalks with mitred curbs, and street-furniture anchors.
//
// Design
// ------
// A road tile (TILE = 8 world units) is diced into an 8x8 grid of 1-unit cells.
// Cells are classified purely from the tile's 4-neighbour connectivity mask:
//
//     core   [1..6] x [1..6]           -> asphalt, always
//     N band [1..6] x  0               -> asphalt if the N neighbour is road, else sidewalk
//     E band  7     x [1..6]           -> asphalt if the E neighbour is road, else sidewalk
//     S band [1..6] x  7               -> asphalt if the S neighbour is road, else sidewalk
//     W band  0     x [1..6]           -> asphalt if the W neighbour is road, else sidewalk
//     corners {0,7} x {0,7}            -> sidewalk, always
//
// That single rule produces, for free: continuous sidewalk runs along straights,
// correctly mitred outer L's and inner nubs at corners, cul-de-sac wraps at dead
// ends and the four corner islands of an intersection. Because the rule is
// evaluated in GLOBAL cell space, curb faces between two adjacent road tiles are
// suppressed automatically, so a straight run reads as one unbroken kerb.
//
// The *geometry* is emitted as the smallest set of rectangles that covers those
// cells, oriented along the road, so a straight tile is ONE asphalt quad running
// the full 8 units (no interior quad boundary anywhere along the carriageway)
// and two full-height sidewalk quads. Tile-to-tile vertices are bit-identical,
// so the surface is watertight.
//
// Markings are analytic in the fragment shader (no texture): crisp at any zoom,
// antialiased with fwidth. Two things make them behave at city scale:
//
//   * DASH PHASE IS GLOBAL. A CPU pass walks every maximal chain of degree<=2
//     road tiles and accumulates true centreline arc length (8 for a straight,
//     2*pi for a quarter-circle corner). The per-tile phase, reduced mod the
//     dash period, is uploaded in an N x N tile data texture. The shader adds
//     the tile's own local arc length to it, so dashes keep perfect period and
//     phase across tile seams AND around corners.
//
//   * CROSSINGS ARE AUTHORED PER JUNCTION, NOT PER TILE. A junction cell (degree
//     >= 3) draws NOTHING. Each approach tile draws one zebra inset from the
//     junction mouth plus a stop bar exactly one stripe-width outboard of it, and
//     mutes its own centre line there. Two approaches can therefore never write
//     into the same corner. When a tile faces two non-opposed junctions (a
//     one-tile corner wedged between two intersections) only the first is drawn,
//     because two perpendicular crossings cannot share a 8x8 cell without
//     crosshatching.
//
// Asphalt is procedural: a generated, mip-mapped, anisotropically filtered
// AGGREGATE ATLAS (see buildAggregateBytes) sampled at 3.70 m and 11.10 m world
// periods, plus resurfacing patches, tar seams, crack families, manhole covers,
// polished wheel tracks along the driving lanes, a slightly lighter crown, and a
// baked contact-AO gradient in the gutter. The atlas is the only source of
// sub-metre detail: in-shader hash noise at 37 cycles/unit cannot be band-limited
// and simply becomes per-pixel salt-and-pepper that the post CAS sharpen then
// amplifies. Everything the atlas does not cover (seams, cracks) goes through
// bvLine(), which antialiases with the field's own derivative and dissolves to
// its mean once sub-pixel.
//
// The gutter term uses bvKerbDist(), an EXACT distance to the nearest kerb (min
// over the convex pieces of the *complement*, which is the true distance
// function) — the old min-of-signed-boxes form under-estimated at concave joins
// and painted a visible dark crease diagonally across every junction.
//
// The kerb reads as a STEP, not a band: the face carries a pure horizontal
// normal, the chamfer is a crisp fragment-shader band at the lip, and there is a
// baked shadow line on the asphalt in the ~8 cm the lip overhangs (curbs
// deliberately do not cast — a 0.15 lip in a 640-unit shadow map is pure acne).
//
// Emitted attributes (the material below is the only consumer):
//   position   vec3   world space (the meshes are at the origin, identity matrix)
//   normal     vec3   flat: +Y on tops, pure horizontal on kerb faces
//   aBvLocal   vec2   tile-local XZ in 0..8 (drives markings)
//   aBvMask    float  0..15 connectivity mask, bit1=N(-Z) 2=E(+X) 4=S(+Z) 8=W(-X)
//   aBvKind    float  0 = asphalt, 1 = sidewalk top, 2 = curb / kerb face
//
// What this module does NOT do: place props (it only returns anchors), draw
// bridge tiles (state.bridge[i]===1 is skipped entirely), or touch terrain.

import * as THREE from '../../vendor/three.module.js';
import { TILE, N, CHUNK } from '../constants.js';

const CHUNKS = Math.ceil(N / CHUNK);
const CELL = TILE / 8;              // 1 world unit per marking cell
const ROAD_TYPE = 3;

// mask bits — identical convention to models.js roadModel(mask)
const BIT_N = 1, BIT_E = 2, BIT_S = 4, BIT_W = 8;
const DIRS = [
  { dx: 0, dz: -1, bit: BIT_N },   // 0 north (-Z)
  { dx: 1, dz: 0, bit: BIT_E },   // 1 east  (+X)
  { dx: 0, dz: 1, bit: BIT_S },   // 2 south (+Z)
  { dx: -1, dz: 0, bit: BIT_W },   // 3 west  (-X)
];
const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

// cell classes
const K_NONE = 0, K_ASPHALT = 1, K_SIDEWALK = 2;
// vertex kinds
const V_ASPHALT = 0, V_WALKTOP = 1, V_CURB = 2;

// Centre-line dash period, world units. Must match BV_DASH_P in the shader.
const DASH_P = 2.0;
// Arc length of a tile's centreline: 8 for a straight / stub, a quarter circle
// of radius 4 for a corner. Indexed by mask.
const ARMS = [];
const CLEN = [];
for (let m = 0; m < 16; m++) {
  const a = [];
  for (let d = 0; d < 4; d++) if (m & DIRS[d].bit) a.push(d);
  ARMS.push(a);
  CLEN.push(a.length === 2 && (a[0] + 2) % 4 !== a[1] ? Math.PI * 2 : TILE);
}

// ---------------------------------------------------------------------------
// Shader
// ---------------------------------------------------------------------------

const GLSL_PARS_VERT = /* glsl */`
attribute vec2 aBvLocal;
attribute float aBvMask;
attribute float aBvKind;
varying vec2 vBvLocal;
varying float vBvMask;
varying float vBvKind;
varying vec3 vBvWorld;
// world +X / +Y / +Z expressed in VIEW space, so the fragment can build a
// tangent frame for the bump without ever mixing world and view normals
varying vec3 vBvTanX;
varying vec3 vBvTanY;
varying vec3 vBvTanZ;
`;

const GLSL_BODY_VERT = /* glsl */`
vBvLocal = aBvLocal;
vBvMask = aBvMask;
vBvKind = aBvKind;
vBvWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vBvTanX = normalize( normalMatrix * vec3( 1.0, 0.0, 0.0 ) );
vBvTanY = normalize( normalMatrix * vec3( 0.0, 1.0, 0.0 ) );
vBvTanZ = normalize( normalMatrix * vec3( 0.0, 0.0, 1.0 ) );
`;

const GLSL_PARS_FRAG = /* glsl */`
varying vec2 vBvLocal;
varying float vBvMask;
varying float vBvKind;
varying vec3 vBvWorld;
varying vec3 vBvTanX;
varying vec3 vBvTanY;
varying vec3 vBvTanZ;

uniform float uBvTime;
uniform float uBvWet;
uniform float uBvSnow;
uniform float uBvDetail;
uniform float uBvNight;
uniform float uBvCurbY0;
uniform float uBvCurbH;
uniform float uBvWear;
uniform vec3  uBvTint;
uniform sampler2D uBvTileTex;
// Procedural aggregate atlas — the ONLY source of sub-metre surface detail.
// rg = relief slope (world x,z), b = aggregate albedo, a = wear / polish mask.
// It carries a full mip chain and max anisotropy, so every one of those terms
// is band-limited by the hardware; the in-shader hash noise it replaced could
// not be, which is what turned the asphalt into per-pixel salt-and-pepper.
uniform sampler2D uBvAgg;

#define BV_MAPN ${N}.0
#define BV_DASH_P ${DASH_P.toFixed(1)}
#define BV_HALFPI 1.5707963
#define BV_TWOPI 6.2831853
// Atlas world periods. 3.70 m carries 3 cm chips .. 1.2 m wear; 11.10 m carries
// 9 cm .. 3.7 m — i.e. the "real 2-4 metre aggregate/wear layer".
#define BV_AGG_A 0.27027
#define BV_AGG_B 0.09009

float bvHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float bvVN( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = bvHash12( i );
  float b = bvHash12( i + vec2( 1.0, 0.0 ) );
  float c = bvHash12( i + vec2( 0.0, 1.0 ) );
  float d = bvHash12( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float bvFbm( vec2 p ) {
  float v = 0.0, a = 0.5;
  for ( int i = 0; i < 4; i ++ ) { v += a * bvVN( p ); p = p * 2.07 + 19.7; a *= 0.5; }
  return v;
}

// --- band-limited thin line ------------------------------------------------
// Coverage of the band |frac(s) - 0.5| < half, antialiased with the field's own
// screen derivative and dissolved to its average once it is sub-pixel. Without
// the dissolve a 0.03-wide seam under a 0.12-world-unit pixel footprint is pure
// aliasing — one of the two things that was reading as per-pixel grain.
float bvLine( float s, float hw, float dsdp ) {
  float aa = max( dsdp * 0.5, 1e-5 );
  float v = 1.0 - smoothstep( hw - aa, hw + aa, abs( fract( s ) - 0.5 ) );
  return mix( v, min( 1.0, hw * 2.0 ), smoothstep( 0.10, 0.38, aa / 0.5 ) );
}

// --- marking primitives ----------------------------------------------------
// All of these return coverage in 0..1 and are analytically antialiased.

float bvBand( float x, float a, float b, float aa ) {
  return smoothstep( a - aa, a + aa, x ) * ( 1.0 - smoothstep( b - aa, b + aa, x ) );
}

// Dash pattern along arclength s. Fades to a solid average once a dash is
// smaller than a pixel, which kills shimmer at max zoom-out.
float bvDash( float s, float period, float duty, float aaS ) {
  float t = fract( s / period );
  float e = max( aaS / period, 0.0015 );
  float d = smoothstep( 0.0, e, t ) * ( 1.0 - smoothstep( duty - e, duty + e, t ) );
  return mix( d, duty, smoothstep( 0.16, 0.42, e ) );
}

// Rotate tile-local p (0..8) so that arm k sits at the north edge.
vec2 bvFrame( vec2 p, int k ) {
  if ( k == 1 ) return vec2( p.y, 8.0 - p.x );
  if ( k == 2 ) return vec2( 8.0 - p.x, 8.0 - p.y );
  if ( k == 3 ) return vec2( 8.0 - p.y, p.x );
  return p;
}

// ---------------------------------------------------------------------------
// Junction approach decal, authored in the APPROACH tile (never in the junction
// cell), expressed in the frame where the junction lies at q.y = 0.
//
//   q.y 0.00 .. 0.55   bare mouth of the junction
//   q.y 0.55 .. 1.95   zebra, 7 equal stripes across the carriageway
//   q.y 1.95 .. 2.30   gap, exactly one stripe width
//   q.y 2.30 .. 2.68   stop bar, near (right-hand) lane only
//
// Every stripe is full length by construction: the 5.40-unit span is exactly 7
// dash periods and the duty cycle closes before the band ends, so no stripe is
// ever clipped by the band edge.
// ---------------------------------------------------------------------------
float bvApproach( vec2 q, float aa ) {
  float inY = bvBand( q.y, 0.55, 1.95, aa );
  float inX = bvBand( q.x, 1.30, 6.70, aa );
  float per = 5.40 / 7.0;
  float t = fract( ( q.x - 1.30 ) / per );
  float e = max( fwidth( q.x ) / per, 0.0015 );
  float stripe = smoothstep( 0.0, e, t ) * ( 1.0 - smoothstep( 0.56 - e, 0.56 + e, t ) );
  stripe = mix( stripe, 0.56, smoothstep( 0.16, 0.42, e ) );
  float zebra = inY * inX * stripe;
  // q.y grows AWAY from the junction, so traffic approaches along -q.y and its
  // right-hand lane is +q.x. The stop bar covers that lane only.
  float bar = bvBand( q.y, 2.30, 2.68, aa ) * bvBand( q.x, 4.00, 6.70, aa );
  return max( zebra, bar );
}

// ---------------------------------------------------------------------------
// Centreline frame.  Returns ( s, lat, kind ):
//   s    arc length along this tile's centreline, 0 at the LOW-index arm
//   lat  signed lateral offset from the centreline, world units
//   kind 0 none (junction / isolated), 1 straight, 2 arc, 3 dead-end stub
// The CPU phase walk uses exactly the same arm ordering and the same arc
// lengths (8.0 / 2*pi), which is what makes dashes phase-continuous.
// ---------------------------------------------------------------------------
vec3 bvCentre( vec2 p, float bN, float bE, float bS, float bW, float deg ) {
  if ( deg > 2.5 ) return vec3( 0.0, 0.0, 0.0 );

  if ( deg > 1.5 ) {
    if ( bN > 0.5 && bS > 0.5 ) return vec3( p.y, p.x - 4.0, 1.0 );
    if ( bE > 0.5 && bW > 0.5 ) return vec3( 8.0 - p.x, p.y - 4.0, 1.0 );
    int k = 0;
    if ( bN > 0.5 && bE > 0.5 ) k = 1;
    else if ( bE > 0.5 && bS > 0.5 ) k = 2;
    else if ( bS > 0.5 && bW > 0.5 ) k = 3;
    vec2 q = bvFrame( p, k );
    float r = length( q );
    float ang = atan( q.y, max( q.x, 1e-4 ) );
    // k == 0 runs N -> W with the low-index arm at ang 0; the other three
    // rotations put the low-index arm at ang = pi/2.
    float s = ( k == 0 ) ? 4.0 * ang : ( BV_TWOPI - 4.0 * ang );
    return vec3( s, r - 4.0, 2.0 );
  }

  if ( deg > 0.5 ) {
    int k = 0;
    if ( bE > 0.5 ) k = 1; else if ( bS > 0.5 ) k = 2; else if ( bW > 0.5 ) k = 3;
    vec2 q = bvFrame( p, k );
    return vec3( q.y, q.x - 4.0, 3.0 );
  }
  return vec3( 0.0, 4.0, 0.0 );
}

// ---------------------------------------------------------------------------
// EXACT distance from a carriageway point to the nearest non-carriageway point.
//
// The carriageway of a tile is ([1,7] x [za,zb]) union ([xa,xb] x [1,7]).  Its
// complement is the union of eight convex pieces — four outer slabs and the four
// 1x1 corner quadrants (corner cells are sidewalk for every mask). Distance to a
// union of sets IS the min of the distances, so this is the true distance
// function: no creases, no under-estimate at concave joins.  Open arms push
// their slab far outside the tile because the carriageway genuinely continues
// into the neighbour there.
// ---------------------------------------------------------------------------
float bvKerbDist( vec2 p, float bN, float bE, float bS, float bW ) {
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

// --- wear primitives -------------------------------------------------------

// Two polished tyre tracks per lane, centred on the wheel paths of a 2.7-unit
// lane. Driven by the lateral centreline offset so tracks follow curves.
float bvTracks( float lat ) {
  float a = abs( lat );
  float t1 = ( a - 0.95 ) / 0.52;
  float t2 = ( a - 2.45 ) / 0.58;
  return clamp( exp( -t1 * t1 ) + 0.72 * exp( -t2 * t2 ), 0.0, 1.0 );
}

// Resurfacing patch: a noise-warped rounded rect on a jittered coarse grid.
float bvPatch( vec2 w, float aa, out float rim ) {
  vec2 c = w * 0.075;
  vec2 i = floor( c );
  float h = bvHash12( i + 3.7 );
  rim = 0.0;
  if ( h < 0.60 ) return 0.0;
  vec2 ctr = ( i + vec2( 0.28 + 0.44 * fract( h * 41.0 ), 0.28 + 0.44 * fract( h * 97.0 ) ) ) * 13.3333;
  vec2 hs = vec2( 1.5 + 2.6 * fract( h * 17.0 ), 1.3 + 2.2 * fract( h * 53.0 ) );
  vec2 d = abs( w - ctr ) - hs;
  float sd = min( max( d.x, d.y ), 0.0 ) + length( max( d, 0.0 ) ) - 0.35;
  sd += ( bvVN( w * 0.85 ) - 0.5 ) * 0.7;
  rim = 1.0 - smoothstep( 0.0, 0.14 + aa, abs( sd ) );
  return 1.0 - smoothstep( -aa, aa, sd );
}

// Manhole / inspection cover on a jittered 13-unit grid.
float bvManhole( vec2 w, float aa, out float rim ) {
  vec2 i = floor( w / 13.0 );
  float h = bvHash12( i + 61.3 );
  rim = 0.0;
  if ( h < 0.52 ) return 0.0;
  vec2 ctr = ( i + vec2( 0.22 + 0.56 * fract( h * 29.0 ), 0.22 + 0.56 * fract( h * 71.0 ) ) ) * 13.0;
  float r = length( w - ctr );
  rim = 1.0 - smoothstep( 0.0, 0.055 + aa, abs( r - 0.62 ) );
  return 1.0 - smoothstep( 0.60 - aa, 0.64 + aa, r );
}
`;

// Injected right after <metalnessmap_fragment>: owns diffuseColor / roughness /
// metalness and stashes a perturbed normal for the block below.
const GLSL_BODY_FRAG = /* glsl */`
vec3 bvW = vBvWorld;
vec2 bvP = vBvLocal;
float bvKind = vBvKind;

float bvPix = max( fwidth( bvW.x ) + fwidth( bvW.z ), 1e-5 );
float bvLod = 1.0 - smoothstep( 0.06, 0.55, bvPix );
float bvDet = uBvDetail * bvLod;
float bvAA = max( bvPix * 0.60, 0.0025 );

// --- per-tile data texture: dash phase (r) and junction adjacency (g) -------
vec2 bvTileIdx = floor( ( bvW.xz - bvP ) / 8.0 + 0.5 );
vec4 bvTileData = texture2D( uBvTileTex, ( bvTileIdx + 0.5 ) / BV_MAPN );

vec3 bvCol;
float bvRough;
float bvMetal = 0.0;
float bvFlat = 0.0;             // 1 = fully wet / mirror-flat
vec2 bvSlope = vec2( 0.0 );     // tangent-space relief slope, filled per branch
float bvCurbT = 0.0;            // 0..1 height up a kerb face

// Sampled OUTSIDE every branch: an implicit-LOD fetch inside non-uniform flow
// has undefined derivatives, which is exactly how a filtered texture silently
// degrades back into aliasing on some drivers.
vec4 bvAgA = texture2D( uBvAgg, bvW.xz * BV_AGG_A );
vec4 bvAgB = texture2D( uBvAgg, bvW.xz * BV_AGG_B + 0.317 );

if ( bvKind < 0.5 ) {

  // ============================ ASPHALT ==================================
  float bN = step( 0.5, mod( vBvMask, 2.0 ) );
  float bE = step( 0.5, mod( floor( vBvMask / 2.0 ), 2.0 ) );
  float bS = step( 0.5, mod( floor( vBvMask / 4.0 ), 2.0 ) );
  float bW = step( 0.5, mod( floor( vBvMask / 8.0 ), 2.0 ) );
  float bvDeg = bN + bE + bS + bW;

  vec3 cen = bvCentre( bvP, bN, bE, bS, bW, bvDeg );
  float kd = bvKerbDist( bvP, bN, bE, bS, bW );

  // Near-neutral, a hair cool and a hair warm in the blotches. The sky IBL
  // supplies the blue; baking more blue into the albedo turns the road violet.
  // Slightly lifted from 0.1180 to hold the previous screen brightness: the
  // aggregate layer raises linear-space variance, and a concave tonemap turns
  // extra variance into a darker mean. Bright, kid-friendly city (§0.5).
  vec3 base = vec3( 0.1274, 0.1280, 0.1318 );

  // patchy tonal variation — old resurfacing, sun bleaching
  float blotch = bvFbm( bvW.xz * 0.045 );
  base *= 0.92 + 0.17 * blotch;
  base = mix( base, base * vec3( 1.07, 1.03, 0.94 ), smoothstep( 0.58, 0.88, blotch ) );

  // ---- aggregate + wear, from the filtered atlas -------------------------
  // Two samples of one tiling atlas at 3.70 m and 11.10 m give continuous
  // surface structure from 3 cm chips to 3.7 m resurfacing patches. Every
  // scale is mip- and anisotropically filtered, so it reads as SURFACE at any
  // zoom instead of dissolving into per-pixel noise.
  float aggFine = bvAgA.b - 0.5;      // 3 - 25 cm chips
  float aggMid  = bvAgB.b - 0.5;      // 10 cm - 1 m
  float wearFine = bvAgA.a;           // 0.7 - 1.3 m polish
  float wearMacro = bvAgB.a;          // 2 - 4 m wear / resurfacing layer

  // Atlas sigma is a known 0.25 (aggStretch), so these read as percent swing:
  // ~9 % from the 2-4 m wear layer, ~17 % from the aggregate itself.
  base *= 0.83 + 0.34 * wearMacro;
  base *= 0.94 + 0.12 * wearFine;
  base *= 1.0 + ( 0.56 * aggFine + 0.42 * aggMid ) * ( 0.40 + 0.60 * bvDet );
  base = mix( base, base * vec3( 1.06, 1.02, 0.96 ), smoothstep( 0.60, 0.98, wearMacro ) );

  bvRough = 0.84 - 0.08 * blotch + 0.16 * aggFine
          - 0.20 * ( wearMacro - 0.5 ) - 0.09 * ( wearFine - 0.5 );

  // ---------------------------- wear -------------------------------------
  float wearAmt = uBvWear * bvDet;

  // resurfacing patches: slightly different mix, hard-ish edge, tar rim
  if ( wearAmt > 0.02 ) {
    float prim;
    float pfill = bvPatch( bvW.xz, bvAA, prim );
    float pa = pfill * wearAmt;
    base = mix( base, base * vec3( 1.13, 1.11, 1.07 ), pa * 0.55 );
    bvRough = mix( bvRough, 0.90, pa * 0.6 );
    base = mix( base, base * 0.70, prim * wearAmt * 0.75 );
  }

  // tar seams — two wandering, noise-warped families of crack sealant. The
  // half-width is a constant in the seam's own parameter; bvLine antialiases
  // with fwidth of THAT parameter and dissolves to its mean once sub-pixel.
  float sc1 = bvW.z * 0.075 + bvFbm( bvW.xz * 0.021 ) * 3.1;
  float s1 = bvLine( sc1, 0.030, fwidth( sc1 ) );
  float sc2 = bvW.x * 0.063 + bvFbm( bvW.zx * 0.019 + 31.7 ) * 2.7;
  float s2 = bvLine( sc2, 0.026, fwidth( sc2 ) );
  float seam = max( s1, s2 ) * bvDet;
  base = mix( base, base * 0.72, seam );
  bvRough = mix( bvRough, 0.45, seam * 0.85 );

  // … and a third, much finer family that reads as hairline cracking
  float cc = bvW.x * 0.21 + bvW.z * 0.06 + bvFbm( bvW.xz * 0.14 + 7.3 ) * 4.2;
  float crack = bvLine( cc, 0.022, fwidth( cc ) )
              * smoothstep( 0.42, 0.72, bvFbm( bvW.xz * 0.05 + 19.0 ) );
  base = mix( base, base * 0.74, crack * wearAmt * 0.8 );

  // polished wheel tracks along the driving lanes. At a junction the lanes of
  // both roads cross, so take the union of the two axes at reduced strength.
  float track;
  if ( bvDeg > 2.5 ) track = 0.55 * max( bvTracks( bvP.x - 4.0 ), bvTracks( bvP.y - 4.0 ) );
  else if ( cen.z > 0.5 ) track = bvTracks( cen.y );
  else track = 0.0;
  track *= uBvWear;
  base *= 1.0 - 0.175 * track;
  bvRough = mix( bvRough, 0.58, track * 0.85 );

  // slightly lighter, slightly domed crown down the middle of the carriageway
  float crown = smoothstep( 0.0, 2.6, kd );
  base *= 1.0 + 0.065 * crown;

  // manholes sit in the carriageway, never in the gutter
  float mrim;
  float hole = bvManhole( bvW.xz, bvAA, mrim ) * smoothstep( 1.1, 1.9, kd ) * bvDet;
  mrim *= smoothstep( 1.1, 1.9, kd ) * bvDet;
  base = mix( base, vec3( 0.086, 0.083, 0.079 ) * ( 0.80 + 0.5 * bvAgA.b ), hole * 0.9 );
  bvRough = mix( bvRough, 0.55, hole * 0.8 );
  base = mix( base, base * 0.55, mrim * 0.85 );

  // ------------------------- kerb contact AO ------------------------------
  // Three terms: a hard SHADOW LINE in the ~8 cm the kerb lip actually
  // overhangs, a tight exponential contact against the face (which a 5.5-unit
  // SSAO radius can never resolve) and a broad, dirtier gutter ramp.
  // bvKerbDist is exact, so none of them creases. The lip line is what makes
  // the kerb read as a STEP rather than a painted band — curbs deliberately do
  // not cast (a 0.15 lip in a 640-unit shadow map is pure acne), so this is the
  // only place that contact can come from.
  float lipLine = exp2( -kd * 13.0 );
  float contact = exp2( -kd * 3.4 );
  float gut = 1.0 - smoothstep( 0.0, 1.85, kd );
  gut *= gut;
  base *= mix( 1.0, 0.50, lipLine * 0.90 );
  base *= mix( 1.0, 0.62, contact * 0.85 );
  base *= mix( 1.0, 0.88, gut );
  bvRough = mix( bvRough, 0.93, gut * 0.55 );

  // ---------------------------- markings ---------------------------------
  const float LW = 0.15;   // centre-line half width
  float mw = 0.0, my = 0.0;

  // junction adjacency bits, authored on the CPU
  float jb = floor( bvTileData.g * 255.0 + 0.5 );
  float j0 = mod( jb, 2.0 );
  float j1 = mod( floor( jb / 2.0 ), 2.0 );
  float j2 = mod( floor( jb / 4.0 ), 2.0 );
  float j3 = mod( floor( jb / 8.0 ), 2.0 );
  float jSelf = mod( floor( jb / 16.0 ), 2.0 );

  float block = 0.0;
  if ( jSelf < 0.5 && bvDeg > 0.5 ) {
    // Two crossings can only coexist in one cell if they are opposed.
    float cnt = j0 + j1 + j2 + j3;
    bool opp = ( cnt < 2.5 ) && ( ( j0 > 0.5 && j2 > 0.5 ) || ( j1 > 0.5 && j3 > 0.5 ) );
    if ( cnt > 1.5 && !opp ) {
      if ( j0 > 0.5 ) { j1 = 0.0; j2 = 0.0; j3 = 0.0; }
      else if ( j1 > 0.5 ) { j2 = 0.0; j3 = 0.0; }
      else if ( j2 > 0.5 ) { j3 = 0.0; }
    }
    if ( j0 > 0.5 ) { vec2 q = bvFrame( bvP, 0 ); mw = max( mw, bvApproach( q, bvAA ) ); block = max( block, 1.0 - smoothstep( 2.20, 2.62, q.y ) ); }
    if ( j1 > 0.5 ) { vec2 q = bvFrame( bvP, 1 ); mw = max( mw, bvApproach( q, bvAA ) ); block = max( block, 1.0 - smoothstep( 2.20, 2.62, q.y ) ); }
    if ( j2 > 0.5 ) { vec2 q = bvFrame( bvP, 2 ); mw = max( mw, bvApproach( q, bvAA ) ); block = max( block, 1.0 - smoothstep( 2.20, 2.62, q.y ) ); }
    if ( j3 > 0.5 ) { vec2 q = bvFrame( bvP, 3 ); mw = max( mw, bvApproach( q, bvAA ) ); block = max( block, 1.0 - smoothstep( 2.20, 2.62, q.y ) ); }
  }

  // yellow centre line — phase carries across tiles and around corners
  if ( cen.z > 0.5 ) {
    float line = 1.0 - smoothstep( LW - bvAA, LW + bvAA, abs( cen.y ) );
    if ( cen.z > 2.5 ) line *= 1.0 - smoothstep( 2.05, 2.45, cen.x );   // stub stops at the turnaround
    float s = bvTileData.r * BV_DASH_P + cen.x;
    my = line * bvDash( s, BV_DASH_P, 0.58, fwidth( cen.x ) ) * ( 1.0 - block );
  }

  // turnaround loop at a genuine cul-de-sac (not at a one-tile stub off a junction)
  if ( bvDeg < 1.5 && ( j0 + j1 + j2 + j3 ) < 0.5 ) {
    mw = max( mw, 1.0 - smoothstep( LW - bvAA, LW + bvAA, abs( length( bvP - vec2( 4.0 ) ) - 1.7 ) ) );
  }

  // paint wears in the wheel tracks
  float pwear = ( 0.86 + 0.14 * bvVN( bvW.xz * 1.7 ) ) * ( 1.0 - 0.22 * track );
  mw = clamp( mw, 0.0, 1.0 ) * pwear;
  my = clamp( my, 0.0, 1.0 ) * pwear;
  // real road paint is retroreflective: it holds its brightness at night
  vec3 WHITE = mix( vec3( 0.840, 0.850, 0.815 ), vec3( 0.960, 0.960, 0.930 ), uBvNight );
  vec3 YELLOW = mix( vec3( 0.900, 0.520, 0.030 ), vec3( 0.960, 0.640, 0.080 ), uBvNight );
  base = mix( base, WHITE, mw );
  base = mix( base, YELLOW, my * ( 1.0 - mw ) );
  float paint = max( mw, my );
  bvRough = mix( bvRough, 0.58, paint );

  // ---------------------------- wetness ----------------------------------
  if ( uBvWet > 0.002 ) {
    // damp everywhere, standing water in the low patches and the gutter
    float pud = smoothstep( 0.46, 0.74, bvFbm( bvW.xz * 0.075 + 5.1 ) );
    pud = clamp( pud + gut * 0.55, 0.0, 1.0 );
    float damp = uBvWet;
    float pool = uBvWet * pud;
    base *= mix( 1.0, 0.58, damp ) * mix( 1.0, 0.62, pool );
    bvRough = mix( mix( bvRough, 0.34, damp ), 0.08, pool );
    bvFlat = max( damp * 0.5, pool );
  }

  bvCol = base;

  // Relief straight out of the mip chain — no finite differences, and it
  // flattens with distance for free instead of shimmering.
  bvSlope = ( ( bvAgA.rg - 0.5 ) * 1.70 + ( bvAgB.rg - 0.5 ) * 0.90 )
          * ( 0.34 * uBvDetail * ( 1.0 - bvFlat ) );

} else {

  // =========================== CONCRETE ==================================
  // Near-neutral: a warm concrete albedo multiplied by a low golden sun is
  // exactly how a small repeating element turns into a chromatic outlier.
  vec3 base = vec3( 0.4180, 0.4150, 0.4045 );

  // 2m paving slabs: per-slab tone + recessed joints (world-locked, so runs
  // read continuously across tile boundaries). Joint width tracks the pixel
  // footprint, so a joint never becomes a sub-pixel black line.
  vec2 slab = floor( bvW.xz * 0.5 );
  base *= 0.94 + 0.13 * bvHash12( slab + 0.5 );
  vec2 jd = abs( fract( bvW.xz * 0.5 ) - 0.5 ) * 2.0;
  float jw = max( 0.16, bvPix * 1.6 );
  float joint = 1.0 - smoothstep( 0.0, jw, min( jd.x, jd.y ) );
  base = mix( base, base * 0.80, joint * ( 0.45 + 0.55 * bvDet ) );

  // aggregate + tonal drift, all from the filtered atlas
  base *= 0.90 + 0.20 * bvAgB.a;
  base *= 1.0 + ( bvAgA.b - 0.5 ) * 0.26 * ( 0.4 + 0.6 * bvDet );
  bvRough = 0.90 - 0.08 * ( bvAgA.b - 0.5 );

  if ( bvKind > 1.5 ) {

    // ------------------------- KERB FACE ---------------------------------
    // The face is emitted with a PURE HORIZONTAL normal (see curbFace()), so
    // it has one honest value that is distinct from the walk top instead of a
    // 45-degree normal smeared down its whole height. Three bands read the
    // step: a dark line where it meets the ground, one clean cast-concrete
    // body, and a bright chamfered lip.
    bvCurbT = clamp( bvW.y / max( uBvCurbY0 + uBvCurbH, 1e-3 ), 0.0, 1.0 );
    float lip = smoothstep( 0.76, 0.98, bvCurbT );
    base *= 0.80;                                                   // distinct step down
    base *= mix( 0.44, 1.0, smoothstep( 0.02, 0.34, bvCurbT ) );    // shadow line at the base
    base *= 1.0 + 0.62 * lip;                                       // chamfer catches the key
    // no slab joints on a cast kerb, and desaturate: whatever colour the key
    // light has, this repeating element must not amplify it.
    base = mix( base, vec3( dot( base, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.35 );
    bvRough = 0.82 - 0.16 * lip;
    // fine aggregate only
    bvSlope = ( bvAgA.rg - 0.5 ) * ( 0.30 * uBvDetail * ( 1.0 - bvFlat ) );

  } else {

    // a dirt line where the walk meets the buildings/grass is too grim for this
    // art direction; instead let snow settle on the walk (roads get ploughed)
    if ( uBvSnow > 0.002 ) {
      float cover = uBvSnow * ( 0.55 + 0.45 * bvFbm( bvW.xz * 0.13 ) );
      base = mix( base, vec3( 0.86, 0.88, 0.93 ), clamp( cover, 0.0, 0.95 ) );
      bvRough = mix( bvRough, 0.72, cover );
    }

    // Slab-joint relief as a ROUNDED V-groove whose width tracks the footprint.
    // The old form differenced a hard step at a fixed 0.09 epsilon, which put
    // an unbounded normal kick on every 2 m joint — evenly spaced bright/dark
    // bars right across the pavement, worst at grazing light.
    vec2 sgn = sign( fract( bvW.xz * 0.5 ) - 0.5 );
    vec2 prof = ( 1.0 - smoothstep( vec2( 0.0 ), vec2( jw ), jd ) )
              * smoothstep( vec2( 0.0 ), vec2( jw * 0.35 ), jd );
    bvSlope = sgn * prof * ( 0.15 * bvDet * ( 1.0 - bvFlat ) )
            + ( bvAgA.rg - 0.5 ) * ( 0.34 * uBvDetail * ( 1.0 - bvFlat ) );
  }

  if ( uBvWet > 0.002 ) {
    base *= mix( 1.0, 0.74, uBvWet );
    bvRough = mix( bvRough, 0.22, uBvWet * 0.8 );
    bvFlat = uBvWet * 0.55;
  }

  bvCol = base;
}

bvCol *= uBvTint;

diffuseColor.rgb = bvCol;
roughnessFactor = clamp( bvRough, 0.03, 1.0 );
metalnessFactor = bvMetal;
`;

// Injected right after <normal_fragment_maps>. (<metalnessmap_fragment> runs
// BEFORE this in three's fragment main, so bvSlope / bvCurbT are in scope.)
const GLSL_NORMAL_FRAG = /* glsl */`
if ( ( abs( bvSlope.x ) + abs( bvSlope.y ) ) > 1e-5 ) {
  normal = normalize( normal + vBvTanX * bvSlope.x + vBvTanZ * bvSlope.y );
}
// The kerb chamfer is synthesised HERE, as a crisp band at the lip, rather
// than baked into the top vertices where linear interpolation smears a 45
// degree normal down the entire face — that smear is what makes every kerb in
// the city a grazing-light catcher and a repeating chromatic outlier.
if ( vBvKind > 1.5 ) {
  float bvLipN = smoothstep( 0.74, 0.99, bvCurbT );
  normal = normalize( mix( normal, normalize( normal + vBvTanY * 1.55 ), bvLipN ) );
}
`;

// ---------------------------------------------------------------------------
// Procedural aggregate atlas (CONTRACTS-RENDER.md §0.2 — generated, no assets)
//
// One 512^2 RGBA texture, tiled seamlessly:
//   rg  relief slope (world x, z), signed, encoded around 0.5
//   b   aggregate albedo
//   a   wear / polish mask
//
// Every octave is a PERIODIC value-noise lattice, so the texture repeats at
// 3.70 m without a visible grid. It is generated once per Roads instance and
// never touched again, so refreshTile() is unaffected.
// ---------------------------------------------------------------------------
const AGG_SIZE = 512;

function aggHash(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Add one periodic value-noise octave (lattice `cells` wide) into `dst`. */
function aggOctave(dst, size, cells, amp, seed) {
  const g = new Float32Array(cells * cells);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) g[y * cells + x] = aggHash(x, y, seed);
  }
  const step = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * step, iy = Math.floor(fy), ty = fy - iy;
    const wy = ty * ty * (3 - 2 * ty);
    const r0 = (iy % cells) * cells, r1 = ((iy + 1) % cells) * cells;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const fx = x * step, ix = Math.floor(fx), tx = fx - ix;
      const wx = tx * tx * (3 - 2 * tx);
      const c0 = ix % cells, c1 = (ix + 1) % cells;
      const a = g[r0 + c0], b = g[r0 + c1], c = g[r1 + c0], d = g[r1 + c1];
      const lo = a + (b - a) * wx, hi = c + (d - c) * wx;
      dst[row + x] += amp * (lo + (hi - lo) * wy);
    }
  }
}

/**
 * Recentre a field on 0.5 and stretch it so ±2 sigma fills 0..1. Value-noise
 * sums land in a narrow band around 0.5; without this the atlas has a standard
 * deviation of ~0.06 and the aggregate layer is invisible no matter what the
 * shader multiplies it by. After this, sigma is a known 0.25, so the shader
 * amplitudes below are literally "percent albedo swing".
 */
function aggStretch(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m += a[i];
  m /= a.length;
  let v = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - m; v += d * d; }
  const sd = Math.sqrt(v / a.length) || 1;
  const k = 1 / (4 * sd);
  for (let i = 0; i < a.length; i++) {
    a[i] = Math.max(0, Math.min(1, 0.5 + (a[i] - m) * k));
  }
}

function buildAggregateBytes(size) {
  const n = size * size;
  const H = new Float32Array(n);   // relief
  const A = new Float32Array(n);   // aggregate albedo
  const W = new Float32Array(n);   // wear / polish

  // Relief: chips at 4 texels (~3 cm) up to clumps at 64 texels (~46 cm).
  // The finest octave is deliberately the SMALLEST contributor — a central
  // difference amplifies the top octave hardest, and at the closest shot 3 cm
  // is barely above one device pixel. The energy lives at 6-46 cm instead,
  // which is the scale the eye reads as surface.
  aggOctave(H, size, 128, 0.28, 11);
  aggOctave(H, size, 64, 0.34, 23);
  aggOctave(H, size, 32, 0.24, 37);
  aggOctave(H, size, 8, 0.14, 53);
  // albedo: partly follows the relief, plus its own 23 cm and 60 cm structure
  aggOctave(A, size, 128, 0.17, 11);
  aggOctave(A, size, 22, 0.43, 71);
  aggOctave(A, size, 6, 0.40, 89);
  // wear: big soft blobs — at the 11.10 m sample these become the 2-4 m layer
  aggOctave(W, size, 3, 0.60, 101);
  aggOctave(W, size, 7, 0.28, 103);
  aggOctave(W, size, 17, 0.12, 107);
  // aggregate albedo: mostly A, a little of the relief so chip tops read light
  for (let i = 0; i < n; i++) A[i] = A[i] * 0.74 + H[i] * 0.26;
  aggStretch(A);
  aggStretch(W);

  // slope from wrapped central differences of H, scaled so the RMS lands near
  // 0.25 of the encodable range (leaves headroom for the peaks)
  const gx = new Float32Array(n), gz = new Float32Array(n);
  let acc = 0;
  for (let y = 0; y < size; y++) {
    const yp = ((y + 1) % size) * size, ym = ((y + size - 1) % size) * size, row = y * size;
    for (let x = 0; x < size; x++) {
      const xp = (x + 1) % size, xm = (x + size - 1) % size;
      const dx = (H[row + xp] - H[row + xm]) * 0.5;
      const dz = (H[yp + x] - H[ym + x]) * 0.5;
      gx[row + x] = dx; gz[row + x] = dz;
      acc += dx * dx + dz * dz;
    }
  }
  const rms = Math.sqrt(acc / (2 * n)) || 1;
  const k = 0.25 / rms;

  const bytes = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    bytes[o] = Math.max(0, Math.min(255, ((gx[i] * k) * 0.5 + 0.5) * 255 + 0.5)) | 0;
    bytes[o + 1] = Math.max(0, Math.min(255, ((gz[i] * k) * 0.5 + 0.5) * 255 + 0.5)) | 0;
    bytes[o + 2] = Math.max(0, Math.min(255, A[i] * 255 + 0.5)) | 0;
    bytes[o + 3] = Math.max(0, Math.min(255, W[i] * 255 + 0.5)) | 0;
  }
  return bytes;
}

/**
 * Max anisotropy. `renderer.capabilities.getMaxAnisotropy()` when a renderer is
 * available (engine.js does not pass one, so also probe a throwaway context);
 * three clamps `texture.anisotropy` to the device max at upload either way, so
 * the fallback is never wrong, only imprecise.
 */
function detectAnisotropy(renderer) {
  try {
    if (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
      return renderer.capabilities.getMaxAnisotropy();
    }
  } catch (e) { /* fall through */ }
  try {
    if (typeof document === 'undefined') return 16;
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 16;
    const ext = gl.getExtension('EXT_texture_filter_anisotropic')
      || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
      || gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
    const v = ext ? gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return v || 16;
  } catch (e) {
    return 16;
  }
}

// ---------------------------------------------------------------------------
// Small deterministic hash for prop placement
// ---------------------------------------------------------------------------
function hash2i(x, z) {
  let h = (x * 374761393 + z * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------

export class Roads {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts]
   *   yOffset      lift above the terrain top face (default 0.02, kills z-fight)
   *   curbHeight   sidewalk rise in world units (default 0.15)
   *   quality      initial quality level 0|1|2
   *   wear         0..1 procedural wear amount (default 1)
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.opts = opts;
    this.yOffset = opts.yOffset != null ? opts.yOffset : 0.02;
    this.curbHeight = opts.curbHeight != null ? opts.curbHeight : 0.15;

    this._chunks = new Map();        // "cx,cz" -> THREE.Mesh
    this._chunkAnchors = new Map();  // "cx,cz" -> anchor[]
    this.anchors = [];

    this._wetTarget = 0;

    // --- per-tile data texture: r = dash phase / DASH_P, g = junction bits ---
    const NN = N * N;
    this._tileBytes = new Uint8Array(NN * 4);
    for (let i = 0; i < NN; i++) this._tileBytes[i * 4 + 3] = 255;
    this._tileTex = new THREE.DataTexture(this._tileBytes, N, N, THREE.RGBAFormat);
    this._tileTex.magFilter = THREE.NearestFilter;
    this._tileTex.minFilter = THREE.NearestFilter;
    this._tileTex.wrapS = this._tileTex.wrapT = THREE.ClampToEdgeWrapping;
    this._tileTex.generateMipmaps = false;
    this._tileTex.needsUpdate = true;

    // --- procedural aggregate atlas (mip + anisotropic) ---------------------
    const tAgg = now();
    this._maxAniso = detectAnisotropy(opts.renderer);
    this._aggTex = new THREE.DataTexture(buildAggregateBytes(AGG_SIZE), AGG_SIZE, AGG_SIZE, THREE.RGBAFormat);
    this._aggTex.wrapS = this._aggTex.wrapT = THREE.RepeatWrapping;
    this._aggTex.magFilter = THREE.LinearFilter;
    this._aggTex.minFilter = THREE.LinearMipmapLinearFilter;
    this._aggTex.generateMipmaps = true;
    this._aggTex.anisotropy = this._maxAniso;
    this._aggTex.needsUpdate = true;
    this._aggMs = now() - tAgg;

    // phase-walk scratch (never reallocated)
    this._mask = new Uint8Array(NN);
    this._road = new Uint8Array(NN);
    this._phase = new Float32Array(NN);
    this._seen = new Uint8Array(NN);
    this._stackI = new Int32Array(NN);
    this._stackB = new Float64Array(NN);

    this.uniforms = {
      uBvTime: { value: 0 },
      uBvWet: { value: 0 },
      uBvSnow: { value: 0 },
      uBvDetail: { value: 1 },
      uBvNight: { value: 0 },
      uBvWear: { value: opts.wear != null ? opts.wear : 1 },
      uBvCurbY0: { value: this.yOffset },
      uBvCurbH: { value: this.curbHeight },
      uBvTint: { value: new THREE.Vector3(1, 1, 1) },
      uBvTileTex: { value: this._tileTex },
      uBvAgg: { value: this._aggTex },
    };

    this.material = this._makeMaterial();
    this.setQuality(opts.quality != null ? opts.quality : 2);

    // scratch, reused across builds — never allocate per frame
    this._cells = new Uint8Array(64);
    this._stats = {
      buildMs: 0, refreshMs: 0, phaseMs: 0, tris: 0, verts: 0, anchors: 0,
      aggMs: this._aggMs, anisotropy: this._maxAniso,
    };
  }

  /**
   * Supply the real renderer so the aggregate atlas gets this device's exact
   * `capabilities.getMaxAnisotropy()`. Optional — the constructor probes for it
   * and three clamps to the device maximum at upload regardless.
   */
  setRenderer(renderer) {
    const a = detectAnisotropy(renderer);
    if (a === this._maxAniso) return this._maxAniso;
    this._maxAniso = a;
    this._stats.anisotropy = a;
    if (this._aggTex) { this._aggTex.anisotropy = a; this._aggTex.needsUpdate = true; }
    return a;
  }

  // -- material ------------------------------------------------------------

  _makeMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.0,
      dithering: true,           // large flat asphalt bands otherwise
      side: THREE.FrontSide,
    });
    mat.name = 'bv-roads';
    const uni = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uni);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + GLSL_PARS_VERT)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + GLSL_BODY_VERT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + GLSL_PARS_FRAG)
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + GLSL_BODY_FRAG)
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + GLSL_NORMAL_FRAG);
      mat.userData.shader = shader;
    };
    mat.customProgramCacheKey = () => 'bv-roads-v3';
    return mat;
  }

  setQuality(level) {
    this._quality = level | 0;
    this.uniforms.uBvDetail.value = this._quality <= 0 ? 0.35 : 1.0;
  }

  setWeather(w) {
    if (!w) return;
    this._wetTarget = Math.max(0, Math.min(1, w.rain || 0));
    this.uniforms.uBvSnow.value = Math.max(0, Math.min(1, w.snow || 0));
    if (w.tint) this.uniforms.uBvTint.value.set(w.tint[0], w.tint[1], w.tint[2]);
  }

  // -- tile queries --------------------------------------------------------

  _isRoad(state, tx, tz) {
    if (tx < 0 || tz < 0 || tx >= N || tz >= N) return false;
    return state.map[tz * N + tx] === ROAD_TYPE;
  }

  /** A road tile that we actually draw (bridges render as water + a deck prop). */
  _isDrawn(state, tx, tz) {
    if (!this._isRoad(state, tx, tz)) return false;
    return !(state.bridge && state.bridge[tz * N + tx] === 1);
  }

  /** 4-neighbour connectivity mask. Bridges DO count as neighbours so the shore
   *  tile opens an arm toward the deck. */
  maskAt(state, tx, tz) {
    let m = 0;
    for (let d = 0; d < 4; d++) {
      const dir = DIRS[d];
      if (this._isRoad(state, tx + dir.dx, tz + dir.dz)) m |= dir.bit;
    }
    return m;
  }

  /** Classify one 1-unit cell of a tile from its mask. */
  static classifyCell(cx, cz, mask) {
    const inX = cx >= 1 && cx <= 6;
    const inZ = cz >= 1 && cz <= 6;
    if (inX && inZ) return K_ASPHALT;
    if (inX && cz === 0) return (mask & BIT_N) ? K_ASPHALT : K_SIDEWALK;
    if (inX && cz === 7) return (mask & BIT_S) ? K_ASPHALT : K_SIDEWALK;
    if (inZ && cx === 7) return (mask & BIT_E) ? K_ASPHALT : K_SIDEWALK;
    if (inZ && cx === 0) return (mask & BIT_W) ? K_ASPHALT : K_SIDEWALK;
    return K_SIDEWALK;   // the four 1x1 corner islands
  }

  /** Cell class in GLOBAL cell space (8 cells per tile). */
  _cellKindGlobal(state, gx, gz) {
    const tx = gx >> 3, tz = gz >> 3;
    if (!this._isDrawn(state, tx, tz)) return K_NONE;
    return Roads.classifyCell(gx & 7, gz & 7, this.maskAt(state, tx, tz));
  }

  // -- global dash phase + junction adjacency ------------------------------

  /**
   * Walk every maximal chain of degree<=2 road tiles and accumulate true
   * centreline arc length, so the dash pattern has one continuous phase from
   * one end of a street to the other — through tile seams and through corners.
   * Also records, per tile, which of its 4 neighbours is a junction (degree>=3),
   * which is what lets crossings be authored per junction instead of per tile.
   *
   * O(number of tiles); the result goes into an N x N data texture, so a
   * refreshTile() never has to rebuild geometry just because a phase moved.
   */
  _rebuildTileData(state) {
    const t0 = now();
    const NN = N * N;
    const mask = this._mask, road = this._road, phase = this._phase;
    const seen = this._seen, stackI = this._stackI, stackB = this._stackB;
    const bytes = this._tileBytes;

    // Tight inline scan — this runs on every refreshTile, so no method calls.
    const map = state.map, bridge = state.bridge;
    for (let tz = 0; tz < N; tz++) {
      const row = tz * N;
      for (let tx = 0; tx < N; tx++) {
        const i = row + tx;
        if (map[i] !== ROAD_TYPE || (bridge && bridge[i] === 1)) { road[i] = 0; mask[i] = 0; continue; }
        road[i] = 1;
        let m = 0;
        if (tz > 0 && map[i - N] === ROAD_TYPE) m |= BIT_N;
        if (tx < N - 1 && map[i + 1] === ROAD_TYPE) m |= BIT_E;
        if (tz < N - 1 && map[i + N] === ROAD_TYPE) m |= BIT_S;
        if (tx > 0 && map[i - 1] === ROAD_TYPE) m |= BIT_W;
        mask[i] = m;
      }
    }
    seen.fill(0);
    phase.fill(0);

    const walk = (start) => {
      let sp = 0;
      stackI[0] = start; stackB[0] = 0; sp = 1;
      while (sp > 0) {
        sp--;
        const t = stackI[sp], base = stackB[sp];
        if (seen[t]) continue;
        seen[t] = 1; phase[t] = base;
        const m = mask[t], arms = ARMS[m], len = CLEN[m];
        const tx = t % N, tz = (t / N) | 0;
        for (let j = 0; j < arms.length; j++) {
          const d = arms[j];
          const nx = tx + DIRS[d].dx, nz = tz + DIRS[d].dz;
          if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
          const ni = nz * N + nx;
          if (!road[ni] || seen[ni]) continue;
          const nm = mask[ni];
          if (POPCOUNT[nm] > 2) continue;              // a junction ends the chain
          const sEdge = (j === 0) ? base : base + len;
          // the neighbour's own low-index arm is at its s = 0; if the shared
          // edge is its HIGH-index arm instead, step back by its length
          const nBase = (ARMS[nm][0] === ((d + 2) & 3)) ? sEdge : sEdge - CLEN[nm];
          stackI[sp] = ni; stackB[sp] = nBase; sp++;
        }
      }
    };

    // chains anchored at a dead end / junction mouth first, then closed loops
    for (let i = 0; i < NN; i++) {
      if (!road[i] || seen[i]) continue;
      const m = mask[i], deg = POPCOUNT[m];
      if (deg > 2) continue;
      let start = deg <= 1;
      if (!start) {
        const tx = i % N, tz = (i / N) | 0;
        const arms = ARMS[m];
        for (let j = 0; j < arms.length && !start; j++) {
          const d = arms[j];
          const nx = tx + DIRS[d].dx, nz = tz + DIRS[d].dz;
          if (nx < 0 || nz < 0 || nx >= N || nz >= N) { start = true; break; }
          const ni = nz * N + nx;
          if (!road[ni] || POPCOUNT[mask[ni]] > 2) start = true;
        }
      }
      if (start) walk(i);
    }
    for (let i = 0; i < NN; i++) {
      if (road[i] && !seen[i] && POPCOUNT[mask[i]] <= 2) walk(i);
    }

    // pack: r = phase mod DASH_P (255 levels over 2 units = 8 mm), g = junction bits
    for (let tz = 0; tz < N; tz++) {
      for (let tx = 0; tx < N; tx++) {
        const i = tz * N + tx, o = i * 4;
        if (!road[i]) { bytes[o] = 0; bytes[o + 1] = 0; continue; }
        let f = phase[i] / DASH_P;
        f -= Math.floor(f);
        bytes[o] = (f * 255 + 0.5) | 0;
        let jb = 0;
        if (tz > 0 && road[i - N] && POPCOUNT[mask[i - N]] >= 3) jb |= 1;
        if (tx < N - 1 && road[i + 1] && POPCOUNT[mask[i + 1]] >= 3) jb |= 2;
        if (tz < N - 1 && road[i + N] && POPCOUNT[mask[i + N]] >= 3) jb |= 4;
        if (tx > 0 && road[i - 1] && POPCOUNT[mask[i - 1]] >= 3) jb |= 8;
        if (POPCOUNT[mask[i]] >= 3) jb |= 16;
        bytes[o + 1] = jb;
      }
    }
    this._tileTex.needsUpdate = true;
    this._stats.phaseMs = now() - t0;
  }

  // -- build ---------------------------------------------------------------

  /**
   * Full rebuild. Returns the street-furniture anchor list:
   *   { x, z, yaw, kind }
   * x/z are WORLD units, y is implied (yOffset + curbHeight for sidewalk props).
   * yaw is the rotation about +Y such that the prop's facing direction is
   * (sin(yaw), 0, cos(yaw)); it always points from the anchor toward the
   * carriageway (or toward oncoming traffic for signals/signs).
   */
  build(state) {
    const t0 = now();
    this._disposeChunks();
    this._rebuildTileData(state);
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) this._buildChunk(state, cx, cz);
    }
    this._collectAnchors();
    let v = 0;
    for (const m of this._chunks.values()) v += m.geometry.getAttribute('position').count;
    this._stats.verts = v;
    this._stats.tris = (v / 3) | 0;
    this._stats.buildMs = now() - t0;
    return this.anchors;
  }

  /** Rebuild the chunk holding (x,z) plus any chunk holding a 4-neighbour
   *  (their masks change when this tile does). Dash phase and junction
   *  adjacency live in a texture, so they update globally without any
   *  geometry work. */
  refreshTile(state, x, z) {
    const t0 = now();
    this._rebuildTileData(state);
    const seen = new Set();
    const touch = (tx, tz) => {
      if (tx < 0 || tz < 0 || tx >= N || tz >= N) return;
      const cx = Math.floor(tx / CHUNK), cz = Math.floor(tz / CHUNK);
      const key = cx + ',' + cz;
      if (seen.has(key)) return;
      seen.add(key);
      this._dropChunk(key);
      this._buildChunk(state, cx, cz);
    };
    touch(x, z);
    for (let d = 0; d < 4; d++) touch(x + DIRS[d].dx, z + DIRS[d].dz);
    this._collectAnchors();
    this._stats.refreshMs = now() - t0;
    return this.anchors;
  }

  getAnchors() { return this.anchors; }
  getStats() { return this._stats; }

  _collectAnchors() {
    const out = [];
    for (const arr of this._chunkAnchors.values()) for (let i = 0; i < arr.length; i++) out.push(arr[i]);
    this.anchors = out;
    this._stats.anchors = out.length;
  }

  _dropChunk(key) {
    const m = this._chunks.get(key);
    if (m) {
      this.scene.remove(m);
      if (m.geometry) m.geometry.dispose();
      this._chunks.delete(key);
    }
    this._chunkAnchors.delete(key);
  }

  _disposeChunks() {
    for (const key of Array.from(this._chunks.keys())) this._dropChunk(key);
    this._chunks.clear();
    this._chunkAnchors.clear();
  }

  _buildChunk(state, cx, cz) {
    const key = cx + ',' + cz;
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const x1 = Math.min(N, x0 + CHUNK), z1 = Math.min(N, z0 + CHUNK);

    const pos = [], nor = [], loc = [], msk = [], knd = [];
    const anchors = [];
    const yA = this.yOffset;                 // asphalt plane
    const yT = this.yOffset + this.curbHeight; // sidewalk top
    const QUAD = [0, 1, 2, 0, 2, 3];

    // Horizontal rect, corners CCW seen from +Y, in tile-local cell units.
    const topRect = (ox, oz, a0, b0, a1, b1, y, m, k) => {
      const X0 = ox + a0 * CELL, X1 = ox + a1 * CELL;
      const Z0 = oz + b0 * CELL, Z1 = oz + b1 * CELL;
      const c = [X0, y, Z0, X0, y, Z1, X1, y, Z1, X1, y, Z0];
      for (let t = 0; t < 6; t++) {
        const vi = QUAD[t] * 3;
        pos.push(c[vi], c[vi + 1], c[vi + 2]);
        nor.push(0, 1, 0);
        loc.push(c[vi] - ox, c[vi + 2] - oz);
        msk.push(m);
        knd.push(k);
      }
    };

    // Vertical kerb face. `d` is the direction the face looks toward
    // (0 = -Z, 1 = +X, 2 = +Z, 3 = -X), `a` the fixed cell index, [b0,b1) the
    // merged run, `t` 1 = onto asphalt (rises from yA), 2 = onto terrain (from 0).
    //
    // ALL four vertices carry the pure horizontal face normal. The chamfer is
    // synthesised in the fragment shader (GLSL_NORMAL_FRAG) as a crisp band at
    // the lip. Tilting the top vertices toward +Y instead, as this used to,
    // makes linear interpolation smear a 45-degree normal down the entire
    // 0.15-unit face: the face then has no value of its own (it reads as a flat
    // grey band, not a step) AND every kerb in the city becomes a grazing-light
    // catcher — a hard chromatic outlier on a repeating structure.
    const curbFace = (ox, oz, d, a, b0, b1, t, m) => {
      const y0 = (t === 2) ? 0 : yA, y1 = yT;
      const S = CELL;
      const nx = DIRS[d].dx, nz = DIRS[d].dz;
      let c;
      if (d === 0) {            // normal -Z; u=+Y, v=+X
        const Z = oz + a * S, X0 = ox + b0 * S, X1 = ox + b1 * S;
        c = [X0, y0, Z, X0, y1, Z, X1, y1, Z, X1, y0, Z];
      } else if (d === 2) {     // normal +Z; u=+X, v=+Y
        const Z = oz + (a + 1) * S, X0 = ox + b0 * S, X1 = ox + b1 * S;
        c = [X0, y0, Z, X1, y0, Z, X1, y1, Z, X0, y1, Z];
      } else if (d === 1) {     // normal +X; u=+Y, v=+Z
        const X = ox + (a + 1) * S, Z0 = oz + b0 * S, Z1 = oz + b1 * S;
        c = [X, y0, Z0, X, y1, Z0, X, y1, Z1, X, y0, Z1];
      } else {                  // normal -X; u=+Z, v=+Y
        const X = ox + a * S, Z0 = oz + b0 * S, Z1 = oz + b1 * S;
        c = [X, y0, Z0, X, y0, Z1, X, y1, Z1, X, y1, Z0];
      }
      for (let q = 0; q < 6; q++) {
        const i = QUAD[q], vi = i * 3;
        pos.push(c[vi], c[vi + 1], c[vi + 2]);
        nor.push(nx, 0, nz);
        loc.push(c[vi] - ox, c[vi + 2] - oz);
        msk.push(m);
        knd.push(V_CURB);
      }
    };

    for (let tz = z0; tz < z1; tz++) {
      for (let tx = x0; tx < x1; tx++) {
        if (!this._isDrawn(state, tx, tz)) continue;
        const mask = this.maskAt(state, tx, tz);
        const ox = tx * TILE, oz = tz * TILE;

        const cells = this._cells;
        for (let c = 0; c < 8; c++) for (let r = 0; r < 8; r++) cells[c * 8 + r] = Roads.classifyCell(r, c, mask);

        // ---- surface rects ---------------------------------------------------
        // Merge along the road so a straight tile is ONE asphalt quad and TWO
        // sidewalk quads, each spanning the full 8 units: no quad boundary ever
        // runs along the carriageway, and tile-to-tile vertices coincide exactly.
        const oN = !!(mask & BIT_N), oE = !!(mask & BIT_E);
        const oS = !!(mask & BIT_S), oW = !!(mask & BIT_W);
        const zA = oN ? 0 : 1, zB = oS ? 8 : 7;
        const xA = oW ? 0 : 1, xB = oE ? 8 : 7;

        if (oN || oS) {
          // vertical-primary: one full-height bar down the middle
          topRect(ox, oz, 1, zA, 7, zB, yA, mask, V_ASPHALT);
          if (oW) topRect(ox, oz, 0, 1, 1, 7, yA, mask, V_ASPHALT);
          if (oE) topRect(ox, oz, 7, 1, 8, 7, yA, mask, V_ASPHALT);

          if (!oW) topRect(ox, oz, 0, 0, 1, 8, yT, mask, V_WALKTOP);
          else { topRect(ox, oz, 0, 0, 1, 1, yT, mask, V_WALKTOP); topRect(ox, oz, 0, 7, 1, 8, yT, mask, V_WALKTOP); }
          if (!oE) topRect(ox, oz, 7, 0, 8, 8, yT, mask, V_WALKTOP);
          else { topRect(ox, oz, 7, 0, 8, 1, yT, mask, V_WALKTOP); topRect(ox, oz, 7, 7, 8, 8, yT, mask, V_WALKTOP); }
          if (!oN) topRect(ox, oz, 1, 0, 7, 1, yT, mask, V_WALKTOP);
          if (!oS) topRect(ox, oz, 1, 7, 7, 8, yT, mask, V_WALKTOP);
        } else {
          // horizontal-primary: one full-width bar across the middle
          topRect(ox, oz, xA, 1, xB, 7, yA, mask, V_ASPHALT);

          if (!oN) topRect(ox, oz, 0, 0, 8, 1, yT, mask, V_WALKTOP);
          else { topRect(ox, oz, 0, 0, 1, 1, yT, mask, V_WALKTOP); topRect(ox, oz, 7, 0, 8, 1, yT, mask, V_WALKTOP); }
          if (!oS) topRect(ox, oz, 0, 7, 8, 8, yT, mask, V_WALKTOP);
          else { topRect(ox, oz, 0, 7, 1, 8, yT, mask, V_WALKTOP); topRect(ox, oz, 7, 7, 8, 8, yT, mask, V_WALKTOP); }
          if (!oW) topRect(ox, oz, 0, 1, 1, 7, yT, mask, V_WALKTOP);
          if (!oE) topRect(ox, oz, 7, 1, 8, 7, yT, mask, V_WALKTOP);
        }

        // ---- kerb faces, run-merged along each of the 4 directions ---------
        // t = 0 none, 1 face onto asphalt (rises from yA), 2 outer face onto
        // terrain (rises from y=0). Only *this* tile's sidewalk cells emit, so
        // shared boundaries are never doubled and sidewalk|sidewalk is silent.
        const gx0 = tx * 8, gz0 = tz * 8;
        for (let d = 0; d < 4; d++) {
          const dxs = DIRS[d].dx, dzs = DIRS[d].dz;
          const along = (d & 1) ? 0 : 1;   // d 1/3 (E/W) fix cx, scan cz
          for (let a = 0; a < 8; a++) {
            let runStart = 0, runType = 0;
            for (let b = 0; b <= 8; b++) {
              let t = 0;
              if (b < 8) {
                const ccx = along ? b : a;
                const ccz = along ? a : b;
                if (cells[ccz * 8 + ccx] === K_SIDEWALK) {
                  const nk = this._cellKindGlobal(state, gx0 + ccx + dxs, gz0 + ccz + dzs);
                  if (nk === K_ASPHALT) t = 1;
                  else if (nk === K_NONE) t = 2;
                }
              }
              if (t !== runType) {
                if (runType !== 0) curbFace(ox, oz, d, a, runStart, b, runType, mask);
                runStart = b; runType = t;
              }
            }
          }
        }

        this._tileAnchors(tx, tz, mask, cells, anchors);
      }
    }

    if (pos.length === 0) { this._chunkAnchors.set(key, anchors); return; }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('aBvLocal', new THREE.Float32BufferAttribute(loc, 2));
    geo.setAttribute('aBvMask', new THREE.Float32BufferAttribute(msk, 1));
    geo.setAttribute('aBvKind', new THREE.Float32BufferAttribute(knd, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'bv-roads-' + key;
    mesh.castShadow = false;      // 0.15 kerbs alias badly in a 640-unit shadow map
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.renderOrder = 0;
    this.scene.add(mesh);
    this._chunks.set(key, mesh);
    this._chunkAnchors.set(key, anchors);
  }

  // -- street furniture ----------------------------------------------------

  _tileAnchors(tx, tz, mask, cells, out) {
    const ox = tx * TILE, oz = tz * TILE;
    const deg = POPCOUNT[mask];
    const push = (lx, lz, yaw, kind) => out.push({ x: ox + lx * CELL, z: oz + lz * CELL, yaw, kind });
    const faceCentre = (lx, lz) => Math.atan2(4 - lx, 4 - lz);
    const h = hash2i(tx, tz);

    if (deg >= 3) {
      // Signals / stop signs on the near-right corner of every approach,
      // facing the oncoming traffic on that approach.
      const kind = deg === 4 ? 'trafficlight' : 'sign_stop';
      if (mask & BIT_N) push(0.5, 0.5, Math.PI, kind);
      if (mask & BIT_E) push(7.5, 0.5, Math.PI * 0.5, kind);
      if (mask & BIT_S) push(7.5, 7.5, 0, kind);
      if (mask & BIT_W) push(0.5, 7.5, -Math.PI * 0.5, kind);
    } else if (deg === 2) {
      if ((mask & BIT_N) && (mask & BIT_S)) {
        if (tz % 2 === 0) {
          const west = (((tz / 2) | 0) + tx) % 2 === 0;
          push(west ? 0.5 : 7.5, 4, west ? Math.PI * 0.5 : -Math.PI * 0.5, 'lamp');
        }
      } else if ((mask & BIT_E) && (mask & BIT_W)) {
        if (tx % 2 === 0) {
          const north = (((tx / 2) | 0) + tz) % 2 === 0;
          push(4, north ? 0.5 : 7.5, north ? 0 : Math.PI, 'lamp');
        }
      } else {
        // corner: lamp on the outer (long) side of the sweep
        const lx = (mask & BIT_W) ? 7.5 : 0.5;
        const lz = (mask & BIT_N) ? 7.5 : 0.5;
        push(lx, lz, faceCentre(lx, lz), 'lamp');
      }
    } else if (deg === 1) {
      // cul-de-sac: one lamp at the head of the turnaround
      if (mask & BIT_N) push(4, 7.5, Math.PI, 'lamp');
      else if (mask & BIT_E) push(0.5, 4, Math.PI * 0.5, 'lamp');
      else if (mask & BIT_S) push(4, 0.5, 0, 'lamp');
      else push(7.5, 4, -Math.PI * 0.5, 'lamp');
    }

    // Sprinkle small props onto genuine sidewalk cells (deterministic).
    const r = h % 17;
    if (r === 3 || r === 9 || r === 13) {
      const kind = r === 3 ? 'hydrant' : (r === 9 ? 'bin' : 'bench');
      const picks = [];
      for (let c = 0; c < 64; c++) if (cells[c] === K_SIDEWALK) picks.push(c);
      if (picks.length) {
        const c = picks[(h >>> 5) % picks.length];
        const lx = (c % 8) + 0.5, lz = ((c / 8) | 0) + 0.5;
        push(lx, lz, faceCentre(lx, lz), kind);
      }
    }
  }

  // -- frame ---------------------------------------------------------------

  update(dt, ctx) {
    const u = this.uniforms;
    u.uBvTime.value += dt || 0;
    if (ctx) {
      if (ctx.quality != null && ctx.quality !== this._quality) this.setQuality(ctx.quality);
      if (ctx.nightEff != null) u.uBvNight.value = ctx.nightEff;
      else if (ctx.nightT != null) u.uBvNight.value = ctx.nightT;
      if (ctx.weather) {
        this._wetTarget = Math.max(0, Math.min(1, ctx.weather.rain || 0));
        u.uBvSnow.value += ((Math.max(0, Math.min(1, ctx.weather.snow || 0))) - u.uBvSnow.value)
          * Math.min(1, (dt || 0) * 0.7);
        const t = ctx.weather.tint;
        if (t) u.uBvTint.value.set(t[0], t[1], t[2]);
      }
    }
    // Wet asphalt dries slowly, wets fast — reads much better than a hard cut.
    const target = this._wetTarget;
    const rate = target > u.uBvWet.value ? 0.8 : 0.12;
    u.uBvWet.value += (target - u.uBvWet.value) * Math.min(1, (dt || 0) * rate);
  }

  dispose() {
    this._disposeChunks();
    if (this.material) this.material.dispose();
    if (this._tileTex) this._tileTex.dispose();
    if (this._aggTex) this._aggTex.dispose();
    this.anchors = [];
  }
}

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------
// selfTest — CONTRACTS-RENDER.md §4
// ---------------------------------------------------------------------------

export function selfTest(renderer) {
  const notes = [];
  let pass = true;
  const fail = (m) => { pass = false; notes.push('FAIL: ' + m); };
  const ok = (m) => notes.push('ok: ' + m);

  // --- cell classification is total and correct -----------------------------
  {
    let bad = 0;
    for (let m = 0; m < 16; m++) {
      for (let cz = 0; cz < 8; cz++) for (let cx = 0; cx < 8; cx++) {
        const k = Roads.classifyCell(cx, cz, m);
        if (k !== K_ASPHALT && k !== K_SIDEWALK) bad++;
      }
      // corners are always sidewalk
      if (Roads.classifyCell(0, 0, m) !== K_SIDEWALK) bad++;
      if (Roads.classifyCell(7, 7, m) !== K_SIDEWALK) bad++;
      // core is always asphalt
      if (Roads.classifyCell(4, 4, m) !== K_ASPHALT) bad++;
    }
    if (bad) fail('classifyCell produced ' + bad + ' invalid cells');
    else ok('classifyCell total over all 16 masks x 64 cells');
  }

  // --- aggregate atlas: tiling, filtered, in range --------------------------
  {
    const t0 = now();
    const bytes = buildAggregateBytes(64);       // small instance: same code path
    const ms = now() - t0;
    let bad = 0;
    for (let i = 0; i < bytes.length; i++) if (!(bytes[i] >= 0 && bytes[i] <= 255)) bad++;
    if (bad) fail(bad + ' aggregate atlas bytes out of range');
    // every channel must actually carry variation (a flat channel = dead layer)
    for (let ch = 0; ch < 4; ch++) {
      let lo = 255, hi = 0;
      for (let i = ch; i < bytes.length; i += 4) { if (bytes[i] < lo) lo = bytes[i]; if (bytes[i] > hi) hi = bytes[i]; }
      if (hi - lo < 40) fail('aggregate atlas channel ' + ch + ' is nearly flat (' + lo + '..' + hi + ')');
    }
    // seam check: the periodic lattice must make column 0 continue column N-1
    let seam = 0, n = 0;
    for (let y = 0; y < 64; y++) {
      for (let ch = 2; ch < 4; ch++) {   // albedo + wear (slopes legitimately flip)
        const a = bytes[(y * 64 + 63) * 4 + ch], b = bytes[(y * 64 + 0) * 4 + ch];
        const c = bytes[(y * 64 + 62) * 4 + ch], d = bytes[(y * 64 + 1) * 4 + ch];
        seam += Math.abs(a - b) - (Math.abs(a - c) + Math.abs(b - d)) * 0.5;
        n++;
      }
    }
    const excess = seam / n;
    if (excess > 6) fail('aggregate atlas does not tile: seam excess ' + excess.toFixed(2) + '/255');
    else ok('aggregate atlas tiles seamlessly (seam excess ' + excess.toFixed(2) + '/255), 64^2 in ' + ms.toFixed(1) + ' ms');
  }

  // --- anisotropy is actually requested -------------------------------------
  {
    const sc = new THREE.Scene();
    const r = new Roads(sc, renderer ? { renderer } : {});
    const a = r._aggTex ? r._aggTex.anisotropy : 0;
    const mip = r._aggTex && r._aggTex.generateMipmaps
      && r._aggTex.minFilter === THREE.LinearMipmapLinearFilter;
    if (!mip) fail('aggregate atlas is not mip-filtered');
    else if (!(a >= 1)) fail('aggregate atlas anisotropy not set (' + a + ')');
    else ok('aggregate atlas mip-mapped, anisotropy ' + a +
      (renderer ? ' (renderer.capabilities.getMaxAnisotropy)' : ' (probed)') +
      ', built in ' + r._stats.aggMs.toFixed(1) + ' ms');
    r.dispose();
  }

  // --- emitted rects cover exactly the classified cells ---------------------
  {
    // Re-derive the merged rect emission and check it is a partition of the
    // 8x8 cell grid with the right class in every cell (this is what makes the
    // surface both seam-minimal AND watertight).
    let bad = 0, maxAsphaltRects = 0;
    for (let m = 0; m < 16; m++) {
      const cover = new Int8Array(64).fill(-1);
      const oN = !!(m & BIT_N), oE = !!(m & BIT_E), oS = !!(m & BIT_S), oW = !!(m & BIT_W);
      const zA = oN ? 0 : 1, zB = oS ? 8 : 7, xA = oW ? 0 : 1, xB = oE ? 8 : 7;
      let nA = 0;
      const rect = (a0, b0, a1, b1, k) => {
        if (k === K_ASPHALT) nA++;
        for (let z = b0; z < b1; z++) for (let x = a0; x < a1; x++) {
          if (cover[z * 8 + x] !== -1) bad++;
          cover[z * 8 + x] = k;
        }
      };
      if (oN || oS) {
        rect(1, zA, 7, zB, K_ASPHALT);
        if (oW) rect(0, 1, 1, 7, K_ASPHALT);
        if (oE) rect(7, 1, 8, 7, K_ASPHALT);
        if (!oW) rect(0, 0, 1, 8, K_SIDEWALK); else { rect(0, 0, 1, 1, K_SIDEWALK); rect(0, 7, 1, 8, K_SIDEWALK); }
        if (!oE) rect(7, 0, 8, 8, K_SIDEWALK); else { rect(7, 0, 8, 1, K_SIDEWALK); rect(7, 7, 8, 8, K_SIDEWALK); }
        if (!oN) rect(1, 0, 7, 1, K_SIDEWALK);
        if (!oS) rect(1, 7, 7, 8, K_SIDEWALK);
      } else {
        rect(xA, 1, xB, 7, K_ASPHALT);
        if (!oN) rect(0, 0, 8, 1, K_SIDEWALK); else { rect(0, 0, 1, 1, K_SIDEWALK); rect(7, 0, 8, 1, K_SIDEWALK); }
        if (!oS) rect(0, 7, 8, 8, K_SIDEWALK); else { rect(0, 7, 1, 8, K_SIDEWALK); rect(7, 7, 8, 8, K_SIDEWALK); }
        if (!oW) rect(0, 1, 1, 7, K_SIDEWALK);
        if (!oE) rect(7, 1, 8, 7, K_SIDEWALK);
      }
      maxAsphaltRects = Math.max(maxAsphaltRects, nA);
      for (let c = 0; c < 64; c++) {
        if (cover[c] !== Roads.classifyCell(c % 8, (c / 8) | 0, m)) bad++;
      }
    }
    if (bad) fail('merged surface rects mismatch classifyCell in ' + bad + ' cells');
    else ok('merged surface rects partition all 16 masks exactly (<=' + maxAsphaltRects + ' asphalt quads/tile)');
  }

  // --- sidewalks join across a straight run (no interior kerb faces) --------
  {
    // a N-S straight: tile (10,10) with road above and below
    const st = makeState();
    for (let z = 8; z <= 12; z++) st.map[z * N + 10] = ROAD_TYPE;
    const scene = new THREE.Scene();
    const roads = new Roads(scene);
    const mid = roads.maskAt(st, 10, 10);
    if (mid !== (BIT_N | BIT_S)) fail('straight mask expected 5, got ' + mid);
    // the cell just north of (10,10)'s west sidewalk column must also be sidewalk
    const a = roads._cellKindGlobal(st, 10 * 8 + 0, 10 * 8 + 0);
    const b = roads._cellKindGlobal(st, 10 * 8 + 0, 10 * 8 - 1);
    if (a !== K_SIDEWALK || b !== K_SIDEWALK) fail('sidewalk not continuous across a tile seam');
    else ok('sidewalk continuous across tile seams on a straight');
    roads.dispose();
  }

  // --- dash phase is continuous across seams AND around corners -------------
  {
    const st = makeState();
    // an S-curve: two corners between three straight runs, plus a long tail
    const R = (x, z) => { st.map[z * N + x] = ROAD_TYPE; };
    for (let z = 10; z <= 20; z++) R(20, z);      // N-S run
    for (let x = 20; x <= 30; x++) R(x, 20);      // corner at (20,20), E-W run
    for (let z = 20; z <= 32; z++) R(30, z);      // corner at (30,20), N-S run
    const sc = new THREE.Scene();
    const r = new Roads(sc);
    r.build(st);
    const ph = r._phase, mk = r._mask;
    // walk the chain and assert the arc-length recurrence holds everywhere
    let worst = 0, checked = 0;
    const P = DASH_P;
    const wrap = (v) => { let t = v / P; t -= Math.round(t); return Math.abs(t) * P; };
    for (let tz = 0; tz < N; tz++) for (let tx = 0; tx < N; tx++) {
      const i = tz * N + tx;
      if (!r._road[i] || POPCOUNT[mk[i]] > 2) continue;
      const arms = ARMS[mk[i]];
      for (let j = 0; j < arms.length; j++) {
        const d = arms[j];
        const nx = tx + DIRS[d].dx, nz = tz + DIRS[d].dz;
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        const ni = nz * N + nx;
        if (!r._road[ni] || POPCOUNT[mk[ni]] > 2) continue;
        const sHere = (j === 0) ? ph[i] : ph[i] + CLEN[mk[i]];
        const nArms = ARMS[mk[ni]];
        const sThere = (nArms[0] === ((d + 2) & 3)) ? ph[ni] : ph[ni] + CLEN[mk[ni]];
        worst = Math.max(worst, wrap(sHere - sThere));
        checked++;
      }
    }
    if (checked === 0) fail('phase continuity test walked no seams');
    else if (worst > 1e-4) fail('dash phase discontinuity of ' + worst.toFixed(5) + ' world units');
    else ok(checked + ' centreline seams (incl. 2 corners) phase-continuous to ' + worst.toExponential(1));
    r.dispose();
  }

  // --- junction adjacency bits are authored per junction --------------------
  {
    const st = makeState();
    for (let x = 10; x <= 20; x++) st.map[15 * N + x] = ROAD_TYPE;
    for (let z = 10; z <= 20; z++) st.map[z * N + 15] = ROAD_TYPE;
    const sc = new THREE.Scene();
    const r = new Roads(sc);
    r.build(st);
    const bytes = r._tileBytes;
    const at = (x, z) => bytes[(z * N + x) * 4 + 1];
    let bad = 0;
    if (!(at(15, 15) & 16)) bad++;                       // the 4-way knows it is one
    if (at(15, 15) & 15) bad++;                          // …and has no junction neighbours
    if (!(at(15, 14) & 4)) bad++;                        // tile north of it: junction to the S
    if (!(at(14, 15) & 2)) bad++;                        // tile west of it: junction to the E
    if (at(12, 15) !== 0) bad++;                         // far away: nothing
    if (bad) fail(bad + ' junction-adjacency bits wrong');
    else ok('junction adjacency authored per junction (self + 4 approaches)');
    r.dispose();
  }

  // --- full build over every topology --------------------------------------
  let roads = null, scene = null, anchors = [];
  {
    const st = topologyState();
    scene = new THREE.Scene();
    roads = new Roads(scene);
    const t0 = now();
    anchors = roads.build(st);
    const ms = now() - t0;
    notes.push('build(' + countRoads(st) + ' road tiles) = ' + ms.toFixed(2) + ' ms (tile data ' +
      roads.getStats().phaseMs.toFixed(2) + ' ms)');

    let verts = 0, nan = 0, meshes = 0;
    scene.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry;
      for (const name of ['position', 'normal', 'aBvLocal', 'aBvMask', 'aBvKind']) {
        const at = g.getAttribute(name);
        if (!at) { fail('missing attribute ' + name); return; }
        if (name === 'position') verts += at.count;
        const arr = at.array;
        for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) { nan++; break; }
      }
      if (g.getAttribute('position').count % 3 !== 0) fail('non-triangular vertex count');
    });
    if (nan) fail(nan + ' attributes contain NaN/Inf');
    else ok('no NaN in ' + meshes + ' chunk meshes, ' + verts + ' verts (' + (verts / 3 | 0) + ' tris)');
    if (verts === 0) fail('build produced no geometry');

    // masks present in the geometry must cover every topology we planted
    const seen = new Set();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const at = o.geometry.getAttribute('aBvMask');
      for (let i = 0; i < at.count; i++) seen.add(at.array[i]);
    });
    const want = [0, 1, 2, 4, 8, 3, 6, 9, 12, 5, 10, 7, 11, 13, 14, 15];
    const missing = want.filter((m) => !seen.has(m));
    if (missing.length) fail('topology masks not exercised: ' + missing.join(','));
    else ok('all 16 connectivity masks present in the test build');
  }

  // --- anchors --------------------------------------------------------------
  {
    const kinds = new Set(['lamp', 'trafficlight', 'sign_stop', 'hydrant', 'bin', 'bench']);
    let bad = 0;
    for (const a of anchors) {
      if (!Number.isFinite(a.x) || !Number.isFinite(a.z) || !Number.isFinite(a.yaw)) bad++;
      else if (!kinds.has(a.kind)) bad++;
      else if (a.x < 0 || a.z < 0 || a.x > N * TILE || a.z > N * TILE) bad++;
    }
    if (bad) fail(bad + ' malformed anchors');
    else ok(anchors.length + ' anchors, all finite / in bounds / known kind');
    if (anchors.length === 0) fail('no street-furniture anchors emitted');
  }

  // --- refreshTile is local and leak-free -----------------------------------
  {
    const st = topologyState();
    const sc = new THREE.Scene();
    const r = new Roads(sc);
    r.build(st);
    // paint a small block once so the chunks involved already exist, then
    // hammer refreshTile without changing the map: the mesh count must be
    // perfectly stable (a leak would show as monotonic growth).
    for (let z = 30; z < 35; z++) for (let x = 30; x < 35; x++) st.map[z * N + x] = ROAD_TYPE;
    r.build(st);
    const base = sc.children.length;
    const anchorsBefore = r.getAnchors().length;
    let worst = 0, total = 0;
    for (let i = 0; i < 100; i++) {
      const x = 30 + (i % 5), z = 30 + (((i / 5) | 0) % 5);
      const t0 = now();
      r.refreshTile(st, x, z);
      const ms = now() - t0;
      worst = Math.max(worst, ms); total += ms;
    }
    if (sc.children.length !== base) fail('refreshTile leaked meshes: ' + base + ' -> ' + sc.children.length);
    else if (r.getAnchors().length !== anchorsBefore) fail('refreshTile duplicated anchors');
    else ok('100 refreshTile cycles leaked nothing (worst ' + worst.toFixed(2) +
      ' ms, mean ' + (total / 100).toFixed(2) + ' ms)');
    r.dispose();
    if (sc.children.length !== 0) fail('dispose() left ' + sc.children.length + ' children');
    else ok('dispose() clears the scene');
  }

  // --- shader compiles -------------------------------------------------------
  if (renderer && renderer.compile) {
    try {
      const cam = new THREE.PerspectiveCamera(40, 1, 1, 2000);
      cam.position.set(100, 100, 100);
      const lit = new THREE.Scene();
      lit.add(new THREE.DirectionalLight(0xffffff, 1));
      lit.add(new THREE.AmbientLight(0xffffff, 0.4));
      for (const c of scene.children.slice(0, 4)) lit.add(c.clone());
      renderer.compile(lit, cam);
      const gl = renderer.getContext();
      const err = gl.getError();
      if (err !== gl.NO_ERROR) fail('GL error after compile: 0x' + err.toString(16));
      else ok('road shader compiled clean');
    } catch (e) {
      fail('shader compile threw: ' + e.message);
    }
  } else {
    notes.push('skip: no renderer supplied, shader not compiled');
  }

  if (roads) roads.dispose();
  return { pass, notes };
}

// -- selfTest fixtures --------------------------------------------------------

function makeState() {
  return {
    map: new Uint8Array(N * N),
    variant: new Uint8Array(N * N),
    bridge: new Uint8Array(N * N),
  };
}

function countRoads(st) {
  let n = 0;
  for (let i = 0; i < st.map.length; i++) if (st.map[i] === ROAD_TYPE) n++;
  return n;
}

/**
 * A map containing every one of the 16 connectivity masks, plus long straights
 * and a dense grid for timing. Exported so tools/rendertest/roads.html renders
 * exactly what selfTest asserts.
 */
export function topologyState() {
  const st = makeState();
  const R = (x, z) => { if (x >= 0 && z >= 0 && x < N && z < N) st.map[z * N + x] = ROAD_TYPE; };

  // One isolated cluster per mask: the centre tile is guaranteed that mask
  // because the clusters are spaced far enough apart to never touch.
  for (let m = 0; m < 16; m++) {
    const x = 4 + (m % 4) * 7;
    const z = 4 + ((m / 4) | 0) * 7;
    R(x, z);
    for (let d = 0; d < 4; d++) if (m & DIRS[d].bit) R(x + DIRS[d].dx, z + DIRS[d].dz);
  }
  // long straights
  for (let z = 34; z < 50; z++) R(6, z);
  for (let x = 6; x < 24; x++) R(x, 52);
  // dense downtown grid
  for (let z = 56; z < 76; z++) for (let x = 40; x < 74; x++) if (x % 4 === 0 || z % 4 === 0) R(x, z);
  return st;
}
