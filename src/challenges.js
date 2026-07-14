// challenges.js — Blockville learning challenges (City Helper) + progress checker.
// PURE LOGIC: no imports, no DOM, no three. Consumed by main.js, which walks the
// GUIDED sequence, drives ui.setMission(), and special-cases nameCity / postcard /
// design goals. Every challenge is GENTLE — reflections are open-ended ("what
// changed?"), never right/wrong, never failure/locks.
//
// A challenge object:
//   { id, title, say, emoji, subject, goal, hint, ask }
//     subject ∈ 'math' | 'civics' | 'environment' | 'literacy' | 'design'
//     say   = warm spoken/kid text.
//     emoji = one big picture emoji for the card.
//     ask   = reflection prompt shown on completion (open-ended).
//
// goal kinds (see CONTRACTS-SANDBOX.md v3.3):
//   {kind:'roads', n}         delta: n new road tiles since mission start
//   {kind:'homes', n}         delta: n new homes
//   {kind:'trees', n}         delta: n new trees
//   {kind:'treesNearFactory', n} delta: n new trees within 6 tiles of a factory
//   {kind:'place', cat, n}    delta: n new buildings in a category
//   {kind:'type', id, n}       delta: n new buildings of one exact type
//   {kind:'shopNearHome', n}  absolute: metrics.shopNearHome >= n
//   {kind:'bridge'}           absolute: a bridge connects both river banks
//   {kind:'nameCity'}         literacy — main passes metrics.cityNamed
//   {kind:'postcard'}         literacy — main passes metrics.postcardTaken
//   {kind:'design'}           open-ended — completes on any placement since start
//                             (main passes metrics.placedSinceStart)

export const CHALLENGES = [
  // ── MATH ──────────────────────────────────────────────────────────────────
  {
    id: 'road5',
    title: 'Build a Road',
    say: "Let's build a road with 5 pieces! Tap and drag to draw a path.",
    emoji: '🛣️',
    subject: 'math',
    goal: { kind: 'roads', n: 5 },
    hint: 'Drag your finger to draw road tiles in a line. Count them: 1, 2, 3, 4, 5!',
    ask: 'How many road pieces did you count? What shape did your road make?',
  },
  {
    id: 'homes3',
    title: 'Three Little Homes',
    say: "Let's add 3 homes so people can move in!",
    emoji: '🏠',
    subject: 'math',
    goal: { kind: 'homes', n: 3 },
    hint: 'Open the Homes drawer, pick a house, and tap the grass 3 times.',
    ask: 'How many people live in your city now? What happened to the number?',
  },
  {
    id: 'homes5',
    title: 'Count to Five Homes',
    say: 'Can you build 5 homes and watch your town grow?',
    emoji: '🏘️',
    subject: 'math',
    goal: { kind: 'homes', n: 5 },
    hint: 'Place homes one by one. Which house is the tallest? Which is the smallest?',
    ask: 'Which home is biggest? How is 5 homes different from 3 homes?',
  },
  {
    id: 'twoByTwo',
    title: 'A Big 2×2 Building',
    say: "Let's use a big building that fills 2 squares by 2 squares!",
    emoji: '🏬',
    subject: 'math',
    goal: { kind: 'design' },
    hint: 'Look for a card with a "2×2" badge — it takes up more room than a little house.',
    ask: 'How many little squares does your big building cover? Count the corners!',
  },

  // ── CIVICS ────────────────────────────────────────────────────────────────
  {
    id: 'shopNear',
    title: 'A Shop for the Neighbors',
    say: "Let's put a shop close to the homes so people can walk to it!",
    emoji: '🏪',
    subject: 'civics',
    goal: { kind: 'shopNearHome', n: 1 },
    hint: 'Pick a shop from the Shops drawer and place it right next to your houses.',
    ask: 'Why is it nice to have a shop close to home? Who might visit it?',
  },
  {
    id: 'school',
    title: 'Build a School',
    say: "Let's place a school so the kids have somewhere to learn!",
    emoji: '🏫',
    subject: 'civics',
    goal: { kind: 'type', id: 'school', n: 1 },
    hint: 'Open the Fun drawer and look for the school. Tap the grass to place it.',
    ask: 'What do people do at a school? Who works there?',
  },
  {
    id: 'firestation',
    title: 'Fire Station Helpers',
    say: "Let's add a fire station to keep everyone safe!",
    emoji: '🚒',
    subject: 'civics',
    goal: { kind: 'type', id: 'fire-station', n: 1 },
    hint: 'Find the fire station in the Fun drawer and place it near the homes.',
    ask: 'How do firefighters help a city? What else keeps people safe?',
  },
  {
    id: 'park',
    title: 'A Park to Play',
    say: "Let's add a park where people can play and rest!",
    emoji: '🏞️',
    subject: 'civics',
    goal: { kind: 'type', id: 'park', n: 1 },
    hint: 'Pick a park from the Fun drawer and place it near where people live.',
    ask: 'What would you do at your park? Did people look happier?',
  },

  // ── ENVIRONMENT ───────────────────────────────────────────────────────────
  {
    id: 'factory',
    title: 'A Factory at Work',
    say: "Let's build a toy factory, then watch what happens to jobs and the air!",
    emoji: '🏭',
    subject: 'environment',
    goal: { kind: 'type', id: 'toy-factory', n: 1 },
    hint: 'Pick the Toy Factory and place it on the grass.',
    ask: 'What came from the factory? What could help keep the air clean?',
  },
  {
    id: 'treesNearFactory',
    title: 'Trees for Clean Air',
    say: 'Factories make smoke. Let\'s plant some trees to help clean the air!',
    emoji: '🌳',
    subject: 'environment',
    goal: { kind: 'treesNearFactory', n: 3 },
    hint: 'Tap the Tree tool and plant trees near your factory. Watch the air get better!',
    ask: 'What happened to the air when you planted trees? How does the city feel now?',
  },
  {
    id: 'windPower',
    title: 'Wind Power Energy',
    say: "Let's add wind power for clean energy — no smoke at all!",
    emoji: '💨',
    subject: 'environment',
    goal: { kind: 'type', id: 'wind-power', n: 1 },
    hint: 'Find the wind turbine in the Fun drawer. Its blades spin in the breeze!',
    ask: 'Where does wind power come from? Why is clean energy good for your city?',
  },

  // ── LITERACY ──────────────────────────────────────────────────────────────
  {
    id: 'nameCity',
    title: 'Name Your City',
    say: 'Every great city needs a name. What will you call yours?',
    emoji: '✏️',
    subject: 'literacy',
    goal: { kind: 'nameCity' },
    hint: 'Tap the name button and type a name for your city. Make it yours!',
    ask: 'Why did you choose that name? What does it tell people about your city?',
  },
  {
    id: 'postcard',
    title: 'Send a Postcard',
    say: "Let's take a postcard picture to share your amazing city!",
    emoji: '📸',
    subject: 'literacy',
    goal: { kind: 'postcard' },
    hint: 'Tap the camera button to snap a postcard of your city.',
    ask: 'Who would you send your postcard to? What would you write on it?',
  },

  // ── DESIGN ────────────────────────────────────────────────────────────────
  {
    id: 'bridge',
    title: 'Cross the River',
    say: "There's a river! Let's build a bridge across it with road pieces.",
    emoji: '🌉',
    subject: 'design',
    goal: { kind: 'bridge' },
    hint: 'Draw a road right onto the blue water — it turns into a bridge!',
    ask: 'How did your bridge help the city? What can cross it now?',
  },
  {
    id: 'ducksPark',
    title: 'A Safe Spot for the Ducks',
    say: 'The ducks need a safe park near the water. Where should it go?',
    emoji: '🦆',
    subject: 'design',
    goal: { kind: 'design' },
    hint: 'There is no wrong answer! Place a park wherever you think the ducks will be happy.',
    ask: 'Why did you pick that spot for the ducks? What makes it safe and fun?',
  },
];

// First-run helper sequence (ordered ids). Matches the user's examples:
// road → 3 homes → shop near homes → bridge, then a couple more gentle ones.
export const GUIDED = ['road5', 'homes3', 'shopNear', 'bridge', 'park', 'factory', 'treesNearFactory'];

// Map a 'place' goal category to the metrics field that counts it.
const CAT_FIELD = {
  homes: 'homes',
  shops: 'shops',
  factories: 'factories',
  fun: 'funCount',
  downtown: 'downtown',
};

function clamp(v, lo, hi) {
  v = Number(v) || 0;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// Snapshot the metric(s) a delta-goal counts from. Absolute goals return {}.
export function makeBaseline(goal, metrics) {
  const m = metrics || {};
  const kind = goal && goal.kind;
  switch (kind) {
    case 'roads':
      return { roads: Number(m.roadTiles) || 0 };
    case 'homes':
      return { homes: Number(m.homes) || 0 };
    case 'trees':
      return { trees: Number(m.trees) || 0 };
    case 'treesNearFactory':
      return { trees: Number(m.treesNearFactories) || 0 };
    case 'place': {
      const field = CAT_FIELD[goal.cat] || goal.cat;
      return { count: Number(m[field]) || 0 };
    }
    case 'type':
      return { count: Number(m.types && m.types[goal.id]) || 0 };
    // Absolute / main-driven goals count from nothing.
    case 'shopNearHome':
    case 'bridge':
    case 'nameCity':
    case 'postcard':
    case 'design':
    default:
      return {};
  }
}

// Compute { done, total, complete }. done is clamped 0..total. Never throws.
export function progress(goal, metrics, baseline) {
  const m = metrics || {};
  const b = baseline || {};
  const kind = goal && goal.kind;

  switch (kind) {
    case 'roads': {
      const total = Math.max(1, Number(goal.n) || 1);
      const done = clamp((Number(m.roadTiles) || 0) - (Number(b.roads) || 0), 0, total);
      return { done, total, complete: done >= total };
    }
    case 'homes': {
      const total = Math.max(1, Number(goal.n) || 1);
      const done = clamp((Number(m.homes) || 0) - (Number(b.homes) || 0), 0, total);
      return { done, total, complete: done >= total };
    }
    case 'trees': {
      const total = Math.max(1, Number(goal.n) || 1);
      const done = clamp((Number(m.trees) || 0) - (Number(b.trees) || 0), 0, total);
      return { done, total, complete: done >= total };
    }
    case 'treesNearFactory': {
      const total = Math.max(1, Number(goal.n) || 1);
      const done = clamp((Number(m.treesNearFactories) || 0) - (Number(b.trees) || 0), 0, total);
      return { done, total, complete: done >= total };
    }
    case 'place': {
      const total = Math.max(1, Number(goal.n) || 1);
      const field = CAT_FIELD[goal.cat] || goal.cat;
      const done = clamp((Number(m[field]) || 0) - (Number(b.count) || 0), 0, total);
      return { done, total, complete: done >= total };
    }
    case 'type': {
      const total = Math.max(1, Number(goal.n) || 1);
      const now = Number(m.types && m.types[goal.id]) || 0;
      const done = clamp(now - (Number(b.count) || 0), 0, total);
      return { done, total, complete: done >= total };
    }
    case 'shopNearHome': {
      const total = Math.max(1, Number(goal.n) || 1);
      const done = clamp(Number(m.shopNearHome) || 0, 0, total);
      return { done, total, complete: (Number(m.shopNearHome) || 0) >= total };
    }
    case 'bridge': {
      const done = (Number(m.bridgeCrossings) || 0) >= 1 ? 1 : 0;
      return { done, total: 1, complete: done >= 1 };
    }
    case 'nameCity': {
      const done = m.cityNamed ? 1 : 0;
      return { done, total: 1, complete: done >= 1 };
    }
    case 'postcard': {
      const done = m.postcardTaken ? 1 : 0;
      return { done, total: 1, complete: done >= 1 };
    }
    case 'design': {
      const done = (Number(m.placedSinceStart) || 0) > 0 ? 1 : 0;
      return { done, total: 1, complete: done >= 1 };
    }
    default:
      // Unknown kind — defensive, never throw.
      return { done: 0, total: 1, complete: false };
  }
}

// Self-test: construct fake metrics/baselines and assert each goal kind computes
// done/total/complete correctly. Returns { ok, ... }.
export function _selfTest() {
  const fails = [];
  const check = (label, cond) => { if (!cond) fails.push(label); };

  // Every challenge is well-formed and spans all five subjects.
  const subjects = new Set();
  for (const c of CHALLENGES) {
    check('challenge-shape:' + c.id, !!(c.id && c.title && c.say && c.emoji && c.subject && c.goal && c.hint && c.ask));
    subjects.add(c.subject);
  }
  check('>=12 challenges', CHALLENGES.length >= 12);
  for (const s of ['math', 'civics', 'environment', 'literacy', 'design']) {
    check('subject-present:' + s, subjects.has(s));
  }
  // GUIDED references real ids in the expected opening order.
  check('guided-order', GUIDED[0] === 'road5' && GUIDED[1] === 'homes3' && GUIDED[2] === 'shopNear' && GUIDED[3] === 'bridge');
  for (const id of GUIDED) check('guided-id:' + id, CHALLENGES.some((c) => c.id === id));

  // roads delta reaches 5.
  {
    const goal = { kind: 'roads', n: 5 };
    const base = makeBaseline(goal, { roadTiles: 10 });
    check('roads-base', base.roads === 10);
    let p = progress(goal, { roadTiles: 12 }, base);
    check('roads-partial', p.done === 2 && p.total === 5 && !p.complete);
    p = progress(goal, { roadTiles: 15 }, base);
    check('roads-complete', p.done === 5 && p.complete);
    p = progress(goal, { roadTiles: 99 }, base); // clamped
    check('roads-clamp', p.done === 5 && p.complete);
    p = progress(goal, { roadTiles: 8 }, base); // went down — never negative
    check('roads-noneg', p.done === 0 && !p.complete);
  }
  // homes delta.
  {
    const goal = { kind: 'homes', n: 3 };
    const base = makeBaseline(goal, { homes: 1 });
    let p = progress(goal, { homes: 3 }, base);
    check('homes-partial', p.done === 2 && !p.complete);
    p = progress(goal, { homes: 4 }, base);
    check('homes-complete', p.done === 3 && p.complete);
  }
  // trees delta.
  {
    const goal = { kind: 'trees', n: 3 };
    const base = makeBaseline(goal, { trees: 40 });
    const p = progress(goal, { trees: 43 }, base);
    check('trees-complete', p.done === 3 && p.complete);
  }
  // Factory greenery counts only nearby trees, not trees anywhere in the city.
  {
    const goal = { kind: 'treesNearFactory', n: 3 };
    const base = makeBaseline(goal, { treesNearFactories: 8 });
    check('factory-trees-base', base.trees === 8);
    check('factory-trees-far-incomplete', !progress(goal, { treesNearFactories: 8, trees: 999 }, base).complete);
    check('factory-trees-near-complete', progress(goal, { treesNearFactories: 11 }, base).complete);
  }
  // place delta with category → field mapping (fun → funCount).
  {
    const goal = { kind: 'place', cat: 'fun', n: 1 };
    const base = makeBaseline(goal, { funCount: 2 });
    check('place-base', base.count === 2);
    let p = progress(goal, { funCount: 2 }, base);
    check('place-incomplete', p.done === 0 && !p.complete);
    p = progress(goal, { funCount: 3 }, base);
    check('place-complete', p.done === 1 && p.complete);
  }
  // exact building type delta.
  {
    const goal = { kind: 'type', id: 'school', n: 1 };
    const base = makeBaseline(goal, { types: { school: 1 } });
    check('type-base', base.count === 1);
    check('type-incomplete', !progress(goal, { types: { school: 1 } }, base).complete);
    check('type-complete', progress(goal, { types: { school: 2 } }, base).complete);
  }
  // shopNearHome absolute.
  {
    const goal = { kind: 'shopNearHome', n: 1 };
    check('shopNear-base-empty', Object.keys(makeBaseline(goal, { shopNearHome: 5 })).length === 0);
    let p = progress(goal, { shopNearHome: 0 }, {});
    check('shopNear-incomplete', p.done === 0 && !p.complete);
    p = progress(goal, { shopNearHome: 2 }, {});
    check('shopNear-complete', p.done === 1 && p.complete);
  }
  // bridge absolute.
  {
    const goal = { kind: 'bridge' };
    check('bridge-incomplete', !progress(goal, { bridgeCrossings: 0 }, {}).complete);
    const p = progress(goal, { bridgeCrossings: 1 }, {});
    check('bridge-complete', p.done === 1 && p.total === 1 && p.complete);
  }
  // nameCity via flag.
  {
    const goal = { kind: 'nameCity' };
    check('name-incomplete', !progress(goal, { cityNamed: false }, {}).complete);
    check('name-complete', progress(goal, { cityNamed: true }, {}).complete);
  }
  // postcard via flag.
  {
    const goal = { kind: 'postcard' };
    check('postcard-incomplete', !progress(goal, { postcardTaken: false }, {}).complete);
    check('postcard-complete', progress(goal, { postcardTaken: true }, {}).complete);
  }
  // design open-ended via placedSinceStart.
  {
    const goal = { kind: 'design' };
    check('design-incomplete', !progress(goal, { placedSinceStart: 0 }, {}).complete);
    check('design-complete', progress(goal, { placedSinceStart: 1 }, {}).complete);
  }
  // unknown kind is defensive.
  {
    const p = progress({ kind: 'wat' }, {}, {});
    check('unknown-safe', p.done === 0 && p.total === 1 && !p.complete);
  }
  // fully defensive against missing metrics/baseline/goal.
  {
    check('no-throw-empty', !!progress({ kind: 'roads', n: 5 }, undefined, undefined));
    check('no-throw-nogoal', !!progress(undefined, undefined, undefined));
  }

  return { ok: fails.length === 0, fails, challenges: CHALLENGES.length };
}
