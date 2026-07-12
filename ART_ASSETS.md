# 🎨 Blockville — Custom Art Asset Brief (for ChatGPT image generation)

This document lists **every button and main-menu image** in Blockville, with a
copy-paste generation prompt for each. It's written for ChatGPT's image generator
(GPT‑4o / DALL·E). Work through it top to bottom, or generate a whole group at once
as a "sprite sheet" for consistency (see **§2 How to use**).

Everything currently renders as an emoji + CSS. Each asset below notes the emoji it
replaces, where it appears, the file name to export, and the export size — so you
can drop the finished PNGs straight into `assets/ui/` and wire them up.

---

## 1. Shared style (READ FIRST — prepend this to every prompt)

**Master style prompt** — paste this at the top of *every* image request, then add
the specific subject line for the asset:

> Create a single game UI icon in a chunky **3D voxel** style — as if built from
> soft, rounded cubes, like a cute Minecraft/Crossy-Road toy. Bright, saturated,
> kid-friendly colors. Thick soft edges, gentle top-down/isometric 3/4 angle,
> smooth soft studio lighting from the upper left, a subtle soft contact shadow
> beneath the object. Clean, friendly, no text unless asked. Centered, with even
> padding (subject fills ~80% of the frame). **Transparent background.** Simple,
> readable at small sizes (this will be shown ~50px wide). Cohesive with a set of
> sibling icons in the exact same style, lighting, and palette.

**Palette** (use these — they match the game's UI and voxel world):

| Role | Hex | Notes |
|---|---|---|
| Accent / highlight | `#FFB703` | sunny yellow (active buttons) |
| Accent deep | `#FB8500` | orange |
| UI text / deep blue | `#2B6A99` | outlines, cool shadows |
| Good / green | `#2FBF71` | success, "go" |
| Alert / red | `#FF5D5D` | erase, blocked, stop |
| Card white | `#FFFFFF` | button faces |
| Grass greens | `#86D94F` / `#74C73F` | world |
| Sky blue | `#87D4F5` | world/menu background |
| Water blue | `#3FA9F0` | |
| Road asphalt | `#40454D` | |
| Sand | `#E6D59A` | |

**Consistency rules (important):**
- Same voxel size/roundness, same camera angle, same light direction across ALL icons.
- Each icon is ONE clear object on transparent background — no scenes, no borders,
  no drop-shadow boxes, no text labels baked in (the UI adds text).
- Keep silhouettes bold and distinct so tiny icons stay readable.

---

## 2. How to use this with ChatGPT

**Option A — one at a time (most reliable):** paste the Master style prompt, then
the asset's "Prompt" line. Ask for a transparent PNG. Download, repeat.

**Option B — cohesive sets (recommended for matching):** ask for a group in one
image, e.g. *"a sprite sheet of 9 icons in a 3×3 grid, same style/lighting, evenly
spaced on a transparent background: [list the 9 subject lines]."* Then, if needed,
ask ChatGPT to "export each icon separately, cropped square, transparent." Doing a
whole group together keeps lighting and proportions identical.

**Transparency tip:** if the generator bakes in a background, add *"on a solid flat
magenta (#FF00FF) background with no shadow touching the edges"* and remove it later
(or use the image tool's transparent-background option). Keep a **small soft contact
shadow** with the object, not a hard rectangle.

**Toggle/state note:** several buttons have ON and OFF looks. Generate both as a
matched pair in one request so they're obviously related (e.g., glowing vs. dimmed).

---

## 3. Technical export specs

| Asset group | Export size (square PNG) | Notes |
|---|---|---|
| Top-bar buttons | **256 × 256** | rendered ~42–46px; 256 gives crisp @Retina |
| Bottom toolbar tools/tabs | **256 × 256** | rendered ~56–68px |
| HUD stat icons | **192 × 192** | small; keep very bold |
| Helper-card buttons | **256 × 256** | |
| Drawer arrows | **128 × 128** | simple chevrons |
| Mode-picker card art | **1024 × 1024** | large hero illustrations |
| Welcome step icons | **384 × 384** | |
| App logo / wordmark | **2048 × 768** (wide, transparent) | title lockup |
| Loading/menu background | **2560 × 1440** | full-bleed, can be non-transparent |
| Favicon source | **512 × 512** | derived from the logo mark |

- Format: **PNG-24 with alpha** (transparent), sRGB.
- Trim to a square canvas with the subject centered; consistent ~10–12% padding.
- Deliver @1x is fine at these sizes; the game downscales.

---

## 4. App logo, loading & favicon

### 4.1 `logo-blockville.png` — wordmark (2048×768)
Replaces the plain "🏗️ Blockville" text on the loading screen and could head the menu.
> **Prompt:** A playful game logo wordmark reading **"BLOCKVILLE"** in chunky 3D
> voxel block letters, each letter built from rounded cubes in bright candy colors
> (sunny yellow #FFB703, sky blue #87D4F5, grass green #86D94F, orange #FB8500),
> with a friendly thick dark-blue #2B6A99 outline and soft shadow. A tiny voxel
> crane or a few little voxel houses perched on top of the letters. Cheerful,
> toy-like, kid-friendly. Transparent background. No extra text.

### 4.2 `menu-bg.png` — loading / main-menu background (2560×1440, opaque OK)
> **Prompt:** A wide, cheerful game background: a sunny voxel landscape seen from a
> gentle isometric angle — rolling green blocky hills, a winding blue voxel river,
> a few tiny cute voxel houses and trees, fluffy low-poly clouds in a soft sky-blue
> #87D4F5 sky. Soft, dreamy, out-of-focus depth so UI reads on top. Bright,
> wholesome, kid-friendly. Lots of open sky in the upper third for a title. No text.

### 4.3 `favicon-mark.png` — app mark (512×512)
> **Prompt:** A single app icon: one adorable chunky voxel house with a sunny-yellow
> roof and a blue door sitting on a small green grass cube, 3/4 view, thick friendly
> outline, soft shadow. Bright and simple, readable at very small sizes. Transparent
> background.

---

## 5. Main menu — mode picker cards

The first screen ("How do you want to play?") has three big choice cards. Each needs
one hero illustration.

### 5.1 `mode-picture-play.png` (1024×1024) — replaces 🧸 "Picture Play · Ages 5–6"
> **Prompt:** A warm, friendly hero icon for a "Picture Play" toddler mode: a cute
> plush voxel teddy bear holding a single big colorful voxel building block, sitting
> on green grass, extra rounded and soft, pastel-bright, giant simple shapes. Very
> gentle and welcoming for ages 5–6. Transparent background.

### 5.2 `mode-city-explorer.png` (1024×1024) — replaces 🏙️ "City Explorer · Ages 7–9"
> **Prompt:** A hero icon for a "City Explorer" mode: a small cheerful voxel city
> skyline — a few colorful voxel skyscrapers, a house, a tree and a tiny road —
> clustered on a green grass base, 3/4 isometric view, bright and lively. A little
> more detailed/grown-up than a toddler icon but still cute. Transparent background.

### 5.3 `mode-everything.png` (1024×1024) — replaces ✨ "Everything · All the tools"
> **Prompt:** A hero icon for an "Everything" sandbox mode: a joyful jumble of many
> tiny voxel objects bursting outward — houses, a ferris wheel, a factory, trees,
> a skyscraper, a car — with a few sparkle/star accents, like an overflowing toy box.
> Colorful, exciting, abundant. Transparent background.

### 5.4 (optional) `mode-card-frame.png` — soft rounded card panel behind each choice
> **Prompt:** A soft rounded-rectangle UI card, white with a subtle warm cream inner
> glow and a thick friendly light outline, gentle drop shadow, like a squishy game
> button. Empty (art goes inside). Transparent background.

---

## 6. Welcome / tutorial step icons (384×384 each)

The welcome card shows three steps. One icon each.

- `step-1-roads.png` — replaces 🛣️
  > **Prompt:** A short piece of chunky voxel road with yellow dashed center line,
  > 3/4 view, one tiny voxel signpost beside it. Bright, friendly. Transparent bg.
- `step-2-build.png` — replaces 🏠
  > **Prompt:** A cute voxel house being placed by a friendly cartoon voxel hand
  > (or a house with a little "drop" sparkle beneath it), 3/4 view. Transparent bg.
- `step-3-alive.png` — replaces 👀
  > **Prompt:** A tiny lively voxel street scene: a little car, a walking voxel person
  > and a tree, with a couple of motion sparkles to say "alive!". Transparent bg.
- `btn-lets-build.png` (optional, 512×256) — the "Let's build! 🚀" button face
  > **Prompt:** A wide, squishy sunny-yellow #FFB703 rounded game button with a soft
  > orange lower edge, a small voxel rocket on the left. No text (added by UI).
  > Transparent background.

---

## 7. Top-bar control buttons (256×256 each)

All are small round-square buttons. Keep each a single bold object on transparent bg.
Where two states exist, generate both as a matched pair.

| File | Replaces | Subject prompt (after the Master style prompt) |
|---|---|---|
| `btn-pause.png` | ⏸️ | Two thick rounded vertical bars (pause), in cool blue #2B6A99, chunky voxel style. |
| `btn-play.png` | ▶️ | A thick rounded right-pointing triangle (play), friendly green #2FBF71. |
| `btn-play-active.png` | ▶️ (selected) | The same play triangle but glowing on a sunny-yellow #FFB703 rounded pad, "selected". |
| `btn-fast.png` | ⏩ | Two thick rounded right triangles (fast-forward), orange #FB8500. |
| `btn-sound-on.png` | 🔊 | A cute voxel speaker with two happy sound waves, blue/white. |
| `btn-sound-off.png` | 🔇 | The same voxel speaker, muted: waves replaced by a soft red #FF5D5D little "x", slightly dimmed. |
| `btn-new-city.png` | 🆕 | A blank green grass cube with a small sparkle/"+" corner, "start fresh" feel. |
| `btn-undo.png` | ↩️ | A thick rounded curved left/back arrow, friendly blue, chunky. |
| `btn-photo.png` | 📷 | An adorable chunky voxel camera with a big round lens and a little flash bulb. |
| `btn-sticker-book.png` | 📖 | A cute closed sticker album/book with a star on the cover, colorful. |
| `btn-help.png` | ❓ | A big friendly rounded question mark, sunny yellow with blue outline, on a soft pad. |
| `btn-readaloud-on.png` | 🗣️ | A friendly speech/mouth bubble with little sound waves, "reading aloud", warm colors, glowing on. |
| `btn-readaloud-off.png` | 🗣️ (off) | The same speech bubble, quiet/dimmed with the sound waves faded. |
| `btn-bright-on.png` | ☀️ | A cheerful chunky voxel sun with rounded rays, glowing sunny yellow (always-bright ON). |
| `btn-bright-off.png` | ☀️ (off) | The same sun but calm/dimmed with a tiny moon peeking, cooler tones (OFF). |
| `btn-cities.png` | 🗂️ | A little stack of labeled voxel city "folders"/save cards, colorful tabs (saved cities). |

---

## 8. HUD stat icons (192×192 each)

Small, non-clickable, but shown constantly — keep them extra bold and simple.

| File | Replaces | Subject prompt |
|---|---|---|
| `stat-people.png` | 👥 | Two or three cute rounded voxel people heads together, warm friendly colors (population). |
| `stat-jobs.png` | 💼 | A small chunky voxel briefcase, brown/tan with a handle (jobs). |
| `stat-air.png` | 🌿 | A single fresh voxel leaf/sprig, bright clean green (clean air). |
| `stat-day.png` | ☀️ | A small simple voxel sun (day indicator). |
| `stat-night.png` | 🌙 | A small friendly voxel crescent moon with a star (night indicator). |

**Happiness face — 4 states** (the face morphs by how happy the city is). Generate
as a matched set of the SAME round voxel face, only the expression changes:

| File | Value | Subject prompt |
|---|---|---|
| `face-sad.png` | low 😟 | A round yellow voxel face, gently worried/sad (small frown, soft brows). Not scary — mild. |
| `face-ok.png` | mid 🙂 | The same face, calm content little smile. |
| `face-happy.png` | high 😀 | The same face, big open happy smile. |
| `face-amazed.png` | max 🤩 | The same face, joyful with star-sparkle eyes and a huge grin. |

---

## 9. Bottom toolbar — tool & category buttons (256×256 each)

These are the big build-menu buttons. Each is a single hero object. This is the most
important set for cohesion — strongly recommend generating all 9 together as one
sprite sheet first.

| File | Replaces | Label | Subject prompt |
|---|---|---|---|
| `tool-road.png` | 🛣️ | Road | A short chunky voxel road tile with yellow dashed center line, 3/4 view. |
| `tab-homes.png` | 🏠 | Homes | One cheerful voxel house, sunny-yellow roof, blue door, on a grass cube. |
| `tab-shops.png` | 🏪 | Shops | A cute voxel corner shop with a striped awning and a little sign. |
| `tab-factories.png` | 🏭 | Factories | A friendly voxel factory with two rounded chimneys and a puff of cloud. |
| `tab-fun.png` | 🎡 | Fun | A colorful voxel ferris wheel, bright and playful. |
| `tab-downtown.png` | 🏙️ | Downtown | Two or three tall colorful voxel skyscrapers clustered together, glass windows. |
| `tab-deco.png` | 🌼 | Deco | A cheerful voxel flower in a little pot, plus a tiny bench hint (decorations). |
| `tool-tree.png` | 🌳 | Tree | One rounded voxel tree, chunky green canopy on a brown trunk. |
| `tool-erase.png` | 🧹 | Erase | A cute voxel broom or eraser block with a small red #FF5D5D accent (remove). |

---

## 10. City Helper card & misc UI (256×256 unless noted)

| File | Replaces | Subject prompt |
|---|---|---|
| `helper-say-again.png` | 🔊 | A friendly speaker with a small circular "replay" arrow around it ("say it again"). |
| `btn-free-build.png` (512×256) | — | A wide squishy soft-blue rounded button face with a tiny voxel hand/blocks, "free play". No text. |
| `btn-next.png` | ▶ | A friendly rounded green "next" arrow in a circle. |
| `arrow-left.png` (128×128) | ‹ | A soft rounded left chevron, light blue, for scrolling the building drawer. |
| `arrow-right.png` (128×128) | › | A soft rounded right chevron, matching `arrow-left`. |
| `helper-badge.png` (optional) | — | A little "City Helper" mascot: a friendly voxel owl or robot guide, waving. Used as the helper-card avatar. |

> **Note on mission pictures:** each guided mission also shows a big emoji (🛣️ 🏠 🏪
> 🌉 🏞️ 🌳 etc.). Those reuse the toolbar/step icons above — you don't need separate
> art unless you want unique mission illustrations. If you do, generate them in the
> same style at 384×384 named `mission-<id>.png` (ids: `road5, homes3, shopNear,
> bridge, park, treesNearFactory, ...`).

---

## 11. Delivery checklist & wiring

When the PNGs are ready:
1. Put them in a new folder `assets/ui/` using the exact file names above.
2. Ping me ("the art is in `assets/ui/`") and I'll swap the emoji for `<img>`/CSS
   `background-image` in `src/ui.js` (and the loading screen in `index.html`), keep
   the existing aria-labels for accessibility, and add graceful emoji fallbacks so
   nothing breaks if an image is missing. I'll also rebuild `dist/blockville.html`
   (note: the single-file build inlines images as base64 data-URIs, so keep source
   PNGs reasonably small — these icon sizes are fine).

**Cohesion checklist before you finalize:**
- [ ] Same camera angle & light direction on every icon
- [ ] Same voxel chunkiness/roundness and outline weight
- [ ] Transparent backgrounds, subject centered, ~10–12% padding
- [ ] Toggle pairs (sound, read-aloud, bright, play) clearly read as on vs. off
- [ ] Each icon still readable shrunk to ~48px (squint test)
- [ ] Palette stays within the table in §1

---

### Quick asset count
Logo/loading/favicon: 3 · Mode picker: 3 (+1 frame) · Welcome: 3 (+1 button) ·
Top bar: 16 · HUD stats: 5 + 4 face states · Toolbar: 9 · Helper/misc: 6 ≈
**~50 images** (plus optional per-mission art). Start with **§9 (toolbar)** and
**§7 (top bar)** — those are on screen the most.
