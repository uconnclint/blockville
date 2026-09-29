# 🏗️ Blockville

Copyright (c) 2026 Clint McLeod. All rights reserved.

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

First run, pick a mode: **🧸 Picture Play** (ages 5–6: big picture choices,
read-aloud, minimal text) or **🏙️ Full Toolbox** (every building, road and tree).
Either way there is nothing to manage: no money, no score, no goals.

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
   a wooden bridge.
5. 👀 **Watch it come alive** — cars drive, people stroll (some walk their dogs!),
   boats drift the river, rides spin, balloons rise, factories puff smoke, windows
   glow at night, fireworks burst over the stadium. Seasons change every 3 days.

**A plain sandbox:** buildings, roads and trees go anywhere they fit, in any order.
Nothing needs homes, jobs, money or a park nearby, and the game never keeps score or
suggests what to build next. The streets fill with cars and walkers as the city grows.

**🤝 Build together (multiplayer):** tap 🤝, choose *Build Together* to get a code
(like `SUNNY-TIGER`), and friends who *Join a Friend* with that code build the SAME
city with you in real time — everyone's roads and buildings appear instantly. Powered
by a tiny Cloudflare Worker + Durable Object (`mp/`); rooms are open, forgiving, and
vanish when everyone leaves.

More: ↩️ undo and 🧹 erase in every mode, 📷 photo postcard (name your city!),
📖 sticker book (all 93 types), 🎯 find-my-city, changeable play modes,
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
- Plain sandbox sim: footprint occupancy, the day/night clock and compact v2 saves
  (`src/sim.js`); living city — cars/pedestrians/boats/dogs/balloons/fireworks/smoke,
  sized by how much has been built (`src/life.js`); category-drawer + a11y
  UI (`src/ui.js`); synthesized WebAudio + speech (`src/audio.js`); wired in
  `src/main.js`.
- Rebuild the single file: `npx esbuild src/main.js --bundle --minify --format=iife`,
  then inline the output into the HTML shell (see `dist/blockville.html`).

Debug console: `BV.paint('mansion', x, z)` (any catalog id, or road/tree/bulldoze),
`BV.ff(seconds)`, `BV.sim.state`.
