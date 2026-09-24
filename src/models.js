// Blockville — voxel art catalog: PUBLIC ENTRY. Pure data + tiny functions.
// No three.js, no DOM. The art itself lives in src/models/*.js, one file per
// category so several artists can re-author categories in parallel:
//
//   core.js         PALETTE, C (colour names), grid(), PRNG, shared + detail helpers
//   residential.js  zoned R growth + catalog 'homes'
//   commercial.js   zoned C growth + catalog 'shops' (+ barber-pole spinner)
//   industrial.js   zoned I growth + catalog 'factories' + wind-power (+ rotor)
//   civic.js        serviceModel (park/school/fire/fountain/stadium/power)
//   fun.js          catalog 'fun' attractions + catalog 'deco' (+ ferris/carousel)
//   downtown.js     catalog 'downtown' offices + skyscrapers
//   vegetation.js   treeModel (+ miniTree/leafRing helpers)
//   infra.js        roadModel, bridgeModel, constructionModel
//   vehicles.js     cars, boats, people, dogs, birds, clouds, smoke, balloons, sparks
//   catalog.js      buildingModel dispatch, CATALOG metadata, catalogModel, catalogAnim
//   selftest.js     _selfTest
//
// Every generator returns { sx, sy, sz, blocks:[[x,y,z,colorIndex], ...], res? }
// with integer coords inside [0,size) and colorIndex valid in PALETTE.
// `res` (optional, default 1) = voxels per world unit: res 2 → 16 voxels per
// 8-unit tile, res 4 → 32. See the authoring guide at the top of core.js.
//
// Determinism: generators seed a tiny mulberry32 PRNG from their `variant` int,
// so the same variant always rebuilds byte-for-byte identically after save/load.
// No Math.random at module load. tools/rendertest/modelhash.mjs hashes every
// model this API can produce — run it before/after any refactor.

export { PALETTE } from './models/core.js';
export { buildingModel, CATALOG, catalogModel, catalogAnim, catalogVents } from './models/catalog.js';
export { serviceModel } from './models/civic.js';
export { treeModel } from './models/vegetation.js';
export { roadModel, bridgeModel, constructionModel } from './models/infra.js';
export {
  carModel, personModel, birdModel, cloudModel, smokePuffModel,
  boatModel, dogModel, balloonModel, sparkModel, parkedRowModel, lotCarsModel,
} from './models/vehicles.js';
export { _selfTest } from './models/selftest.js';
