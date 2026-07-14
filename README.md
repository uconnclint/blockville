# 🏗️ Blockville

A kid-friendly voxel city **sandbox** — build whatever you want, no money, no rules.
Runs in any modern browser on Chromebooks, iPads, and desktops. No install, no accounts, no ads.

**▶ Play it live: https://blockville.pages.dev**

## Play

**Easiest:** open `dist/blockville.html` — the whole game in one file. Double-click it,
put it on Google Drive/Classroom, or host it anywhere static.

**From source:** serve this folder with any static server and open `index.html`:

```sh
python3 -m http.server 8347
# → http://localhost:8347
```

(ES modules require http:// — opening index.html via file:// won't work; use the dist file for that.)

## How to play

First run, pick a mode: **🧸 Picture Play** (ages 5–6: six big picture choices,
read-aloud, minimal text), **🏙️ City Explorer** (ages 7–9: full catalog + stats +
guided missions), or **✨ Everything** (the whole toolbox, nothing hidden).

1. ✋ **Move safely** — the dedicated Move tool pans the map. If a building or
   tree is selected, a tap places it while a drag pans instead, so exploring can
   never paint an accidental row of buildings. Arrow keys + Enter also work.
2. 🛣️ **Draw roads** — tap Road, then drag. Mostly-straight drags snap to a clean
   grid line (no more iso staircase), with a path preview as you go.
3. 🏠 **Pick buildings** — tap a category (Homes / Shops / Factories / Fun /
   🏙️ Downtown / 🌼 Deco) and a drawer slides up: **93 types** — houses, cottages,
   apartments, mansions; shops, malls, a cinema; factories; a carousel, ferris
   wheel, stadium, and zoo; a downtown of office towers and glass skyscrapers that
   light up at night; and deco (benches, flowers, streetlights, statues). Buildings
   turn to face the nearest road. If a spot won't work you get a red footprint and
   a friendly reason ("This building needs grass").
4. 🌉 **Cross the river** — drag a road from one bank to the other and it becomes
   a wooden bridge. The helper only celebrates after both banks are connected.
5. 🧭 **City Helper** (optional) — little missions with a picture, read-aloud
   directions, and "2 of 3" progress: *build a road with 5 pieces*, *add 3 homes*,
   *put a shop near the homes*, *build a bridge across the river*… tap **Free Build**
   any time to just play.
6. 👀 **Watch it come alive** — cars drive, people stroll (some walk their dogs!),
   boats drift the river, rides spin, balloons rise, factories puff smoke, windows
   glow at night, fireworks burst over the stadium. Seasons change every 3 days.

**Cause & effect (gentle):** homes bring people, shops give places to visit, parks
and trees make neighborhoods happier and cleaner, factories make smoke (plant trees
to help!). The HUD shows 👥 people, 💼 jobs, a 😀 happiness face, and 🌿 clean-air —
the game only *suggests*, never punishes.

**🤝 Build together (multiplayer):** tap 🤝, choose *Build Together* to get a code
(like `SUNNY-TIGER`), and friends who *Join a Friend* with that code build the SAME
city with you in real time — everyone's roads and buildings appear instantly. Powered
by a tiny Cloudflare Worker + Durable Object (`mp/`); rooms are open, forgiving, and
vanish when everyone leaves.

More: ↩️ undo and 🧹 erase in every mode, 📷 photo postcard (name your city!),
📖 sticker book (all 93 types), 🎯 find-my-city, optional project library,
changeable play modes,
🗂️ several saved cities, ❓ replayable help, ☀️ always-bright and 🔊 read-aloud
toggles, plus screen-reader labels, focusable dialogs, and reduced-motion support.

Choose Move and drag to move the camera, pinch or scroll to zoom, two-finger twist or right-drag
to rotate. Day turns to night on a 2-minute cycle. 🧹 Erase removes anything. Each
city autosaves; start or switch cities from 🗂️.

## Tech

- Plain ES modules, zero build step; Three.js r160 vendored in `vendor/`.
- 80×80 procedurally-generated map (oceans, lakes, rivers, snow-capped mountains, forests); buildings up to 4×4 footprints (stadium is the 4×4 showpiece).
- 93-type building catalog across six categories (homes, shops, factories, fun,
  downtown skyscrapers, deco; incl. animated rides), all pure-data voxel models
  (`src/models.js`), meshed with hidden-face culling (`src/engine.js`).
- Sandbox sim with footprint occupancy, cosmetic cause-and-effect stats
  (residents/jobs/happiness/air) + compact v2 saves (`src/sim.js`); learning
  challenges (`src/challenges.js`); living city — cars/pedestrians/boats/dogs/
  balloons/fireworks/smoke (`src/life.js`); category-drawer + City-Helper + a11y
  UI (`src/ui.js`); synthesized WebAudio + speech (`src/audio.js`); wired in
  `src/main.js`.
- Rebuild the single file: `npx esbuild src/main.js --bundle --minify --format=iife`,
  then inline the output into the HTML shell (see `dist/blockville.html`).

Debug console: `BV.paint('mansion', x, z)` (any catalog id, or road/tree/bulldoze),
`BV.ff(seconds)`, `BV.sim.state`.
