// Blockville shared constants — imported by every module. Keep dependency-free.

export const TILE = 8;      // world units per tile
export const N = 40;        // tiles per map side (v3.8: 80 -> 40 for iPad/Chromebook speed; all buildable)

// Tile types stored in state.map
export const T = {
  GRASS: 0, WATER: 1, SAND: 2, ROAD: 3,
  ZONE_R: 4, ZONE_C: 5, ZONE_I: 6,   // painted zones (not yet grown)
  BLDG: 7,                            // grown building (see zoneOf/level)
  TREE: 8, PARK: 9, SCHOOL: 10, FIRE: 11,
  FOUNTAIN: 12, STADIUM: 13, POWER: 14,
  MOUNTAIN: 15,                       // raised rocky terrain; height in state.variant[i]
};

export const DAY_LENGTH = 120;   // real seconds per in-game day at speed 1
export const CHUNK = 16;         // tiles per terrain chunk side (4x4 chunks at N=64)

export const idx = (x, z) => z * N + x;
export const inBounds = (x, z) => x >= 0 && z >= 0 && x < N && z < N;

// Home/job capacity per building level (index 1..3)
export const CAPACITY = [0, 4, 10, 24];
