# Menu icons: original art in place of emoji

Clint asked: "at some point replace any emoji that you used in the menus with original art."

## What was built

The new code is in four new files. Wiring changes in `ui.js` and `main.js` are small. No renderer or model file was edited; the icon code only calls them read-only.

| file | role |
|---|---|
| `src/iconmesh.js` | Pure, with no DOM. Turns an icon job into typed-array meshes, using the game's own `models.js` builders and `render/voxel.js` `buildVoxelGeometry`. Catalog jobs include `m.parts` and the `catalogAnim` moving piece (for example, the ferris wheel's wheel). Very fine models (res 8-12) are resampled with `lodModel` to the largest divisor of res that is 6 or less, so a tower takes about 0.3 s to mesh instead of about 3 s. Small props (people, balloon) stay at full res. This file also holds the **hand-authored mini voxel models**: hand (Move), target, star, island-with-flag (projects), rocket, key, pencil, trash bin. They use their own bright palette. |
| `src/iconrender.js` | A private `WebGLRenderer` on an OffscreenCanvas (or a DOM canvas as fallback). It uses a true-isometric ortho camera (the game's 35.26° elevation, 45° diagonal, +Z front on the left). The key light comes from the viewer's upper left, with sky/ground fill, the mesher's voxel AO, a slight sky tint on glass, and a soft radial contact shadow. The camera is framed on the real vertices. Output is a 144 px transparent PNG data URL. |
| `src/iconworker.js` | Module Web Worker. It runs the queue one job at a time with an 8 ms pause between jobs, so it never pins a core. It meshes and draws in the worker and posts `{type:'icon', key, url}`. A `bump` message moves wanted keys to the front of the queue. When it finishes it frees its GL context. |
| `src/icons.js` | Main-thread coordinator. `startIcons({catalog, onIcon})` returns `{want(keys), done, stats}`. It also defines the menu job list (`MENU_JOBS`) and the catalog jobs (`cat-<id>`). |

**Wiring:**
- `main.js` calls `startMenuIcons()` 900 ms after boot and routes `onIcon` to `ui.setArt(key, url)`.
- `ui.js` calls the hook `onArtWanted(keys)` whenever a glyph shows an emoji because its icon isn't ready. `main.js` forwards those keys to `icons.want`, so the drawer or sticker book the player has open is drawn first.
- `?noicons` in the URL disables the factory, for perf A/B runs.
- `BV.icons.stats` shows how many icons the worker drew and how much main-thread render time was spent (0 in the normal path).

**ui.js:**
- `setGlyph` now also reads `RUNTIME_ART`. Baked PNG art in `ART` still wins.
- `setGlyph` tags each container with `data-art-key` and remembers its emoji. When `setArt` arrives, every live glyph with that key is upgraded in place.
- The emoji shows until the icon is ready (the existing fallback). If an image fails to load, the emoji comes back.
- New helpers: `glyphSpan`, `iconLabel`, and `EMOJI_ART`. `EMOJI_ART` maps the emoji that `main.js` and `challenges.js` pass in (missions, projects, toasts) to art keys.

**Fallbacks:**
- The worker has no WebGL OffscreenCanvas: it posts the mesh arrays, and `icons.js` draws them on the main thread, one per idle callback.
- No module workers (for example, a bundled single-file build): mesh and draw happen on the main thread in idle callbacks, wanted keys first. **This path stalls:** building one model can block the main thread for 50-600 ms.
- No WebGL: the emoji stay.

**For the dist single-file build:**
- Bundle the worker on its own: `npx esbuild src/iconworker.js --bundle --format=iife`.
- Inline it into the page as a string: `globalThis.BV_ICON_WORKER_SRC = "…"`.
- `icons.js` then starts the worker from a Blob URL instead of using `import.meta.url`.
- Without this step, the dist build uses the main-thread fallback above.

No localStorage cache. The worker path costs the main thread nothing, and localStorage is shared with city saves (5 MB), so about 90 × 10 KB of PNGs isn't worth the risk. The worker rebuilds the icons each session in about 15 s on a loaded machine, wanted keys first.

## Where the icons now appear
- **Build drawer cards:** all 93 catalog buildings, rendered from their own model (`cat-<id>`).
- **Sticker book:** cells (locked ones stay greyscale), the title (sticker-book PNG), and the section headers (tab PNGs).
- **Favourites ("Recent") row** and its star tag.
- **Picture-play palette:** entries use `cat-<id>`; tools use the tab/tool PNGs, and Move uses the voxel hand.
- **Selected-tool banner.**
- **Toolbar:** the Move tool now has the voxel hand. Road, Tree, Erase and the category tabs keep their existing PNG art (see below).
- **Top bar:** "Find my city" uses the target. `btn-multiplayer` (which had no PNG) now shows two game people, built from `personModel`. The multiplayer room badge uses the same icon.
- **City helper mission badge:** mapped from the mission emoji (road, homes, 2×2 → mall, shop, school, fire station, park, factory, trees, wind power, pencil, photo, bridge → `bridgeModel`, ducks → pond).
- **Help menu:** How to play (help PNG), Choose a project (island), Change play mode (picture-play PNG), Restart helper missions (target). The dialog title uses the help PNG.
- **Projects list:** one icon per mission.
- **Splash:** Start Building (rocket) or Continue (play PNG), New City (PNG), Play With a Friend (the two people).
- **Multiplayer panel:** title, host button (the game's balloon model), join button (key). The "Join a Friend" title uses the key.
- **City manager:** play, rename (pencil), delete (trash bin), the "My Cities" title, New City, and the population glyph.
- **Welcome dialog:** the title and the Move step.
- **Toasts:** any emoji in `EMOJI_ART` shows its art. Unmapped emoji stay as emoji.

## Emoji left on purpose
- **Toolbar tabs and the Road/Tree/Erase tools** already had original PNG art (`tab-*`, `tool-*`, made per ART_ASSETS.md), so there was no emoji to replace. The runtime renderer can produce equivalents, but those PNGs are richer, so they stay.
- **Prose and celebrations:** confetti emoji, celebration titles such as "Hooray! 🎉", emoji inside toast sentences, and the `blockedMessage` tails. Toasts *with* a mapped emoji do get art in their icon slot.
- **Unmapped toast icons:** 🤷, 👋, 🚫 and similar.
- **Clock labels** (🌙 Night / 🌅 Morning …): these are text. The stat icon itself already swaps day/night PNGs.
- **✕ close buttons and "Next ▶":** these are typographic symbols, not pictures.
- **The 🍎 teacher-guide link:** a prose link for grown-ups.
- **The "🏗️ Blockville" fallback title and the favicon/boot `<h1>` in `index.html`:** these appear only when the logo PNG is missing or before the modules load.
- **`catalog.js` `emoji` fields:** kept. They are the fallback shown before an icon lands, and they're used in speech/toast text. Removing them is not needed.

## Verification (2026-09-26)
- `tools/rendertest/check.sh`: all modules parse, after every edit.
- Custom CDP run with the UI visible: `scratchpad/icons/uishot.mjs`.
  - All 93 sticker cells and every drawer (homes 12, shops 20, factories 17, fun 16, downtown 17, deco 11) show `<img>` icons, with 0 emoji left in those menus.
  - Zero console errors or warnings.
  - The whole catalog was ready about 15 s after load, while 13 other agents were loading the machine.
- Perf (`scratchpad/icons/perf.mjs`, a `?noicons` A/B): with the worker path, `BV.icons.stats = {worker:104, mainRenders:0}`, so no icon work ran on the main thread. The first version rendered on the main thread and cost about 114 ms per icon; that is what drove the move to OffscreenCanvas. The fps swings seen in both A and B runs come from the shared machine, not the icons.
- Screenshots are in `/private/tmp/claude-501/-Users-clintonmcleod-AI-skylines/5fc12e46-b935-4e31-941f-6553148850f6/scratchpad/icons/r2/`:
  - `03-stickerbook.png`, `04-stickerbook-bottom.png`
  - `05-drawer-{homes,shops,factories,fun,downtown,deco}.png`
  - `01-splash.png`, `07-help.png`, `08-projects.png`, `09-cities.png`, `10-multiplayer.png`, `06-banner.png`
