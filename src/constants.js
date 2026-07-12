// Blockville shared constants — imported by every module. Keep dependency-free.

export const TILE = 8;      // world units per tile
export const N = 64;        // tiles per map side (v3.1: a third bigger than the old 48)

// Tile types stored in state.map
export const T = {
  GRASS: 0, WATER: 1, SAND: 2, ROAD: 3,
  ZONE_R: 4, ZONE_C: 5, ZONE_I: 6,   // painted zones (not yet grown)
  BLDG: 7,                            // grown building (see zoneOf/level)
  TREE: 8, PARK: 9, SCHOOL: 10, FIRE: 11,
  FOUNTAIN: 12, STADIUM: 13, POWER: 14,
};

// Tools — id, what they paint, cost
export const TOOLS = {
  road:      { cost: 10,  paints: T.ROAD },
  home:      { cost: 20,  paints: T.ZONE_R },
  shop:      { cost: 30,  paints: T.ZONE_C },
  factory:   { cost: 40,  paints: T.ZONE_I },
  tree:      { cost: 5,   paints: T.TREE },
  park:      { cost: 60,  paints: T.PARK },
  school:    { cost: 150, paints: T.SCHOOL },
  fire:      { cost: 120, paints: T.FIRE },
  fountain:  { cost: 100, paints: T.FOUNTAIN },
  power:     { cost: 200, paints: T.POWER },
  stadium:   { cost: 400, paints: T.STADIUM },
  bulldoze:  { cost: 0,   paints: -1 },
};

// Tool unlock thresholds by population
export const UNLOCKS = [
  { pop: 25,  tool: 'factory' },
  { pop: 75,  tool: 'school' },
  { pop: 75,  tool: 'fire' },
  { pop: 150, tool: 'fountain' },
  { pop: 150, tool: 'power' },
  { pop: 300, tool: 'stadium' },
];

export const DAY_LENGTH = 120;   // real seconds per in-game day at speed 1
export const CHUNK = 16;         // tiles per terrain chunk side (4x4 chunks at N=64)

export const idx = (x, z) => z * N + x;
export const inBounds = (x, z) => x >= 0 && z >= 0 && x < N && z < N;

// Home/job capacity per building level (index 1..3)
export const CAPACITY = [0, 4, 10, 24];
