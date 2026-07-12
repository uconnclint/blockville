// Blockville — ui.js  (SANDBOX)
// Kid-friendly HUD: floating top stats bar, category toolbar with sliding
// building drawers, toasts, celebrate confetti, and a first-run welcome card.
//
// Module top level is DOM-free (parses in Node). ART is a pure data map
// (key -> base64 data URI) so importing it is safe in Node too; if it's ever
// unavailable, every icon gracefully falls back to its emoji.

import { ART } from './art.js';

// ---- static config (pure data, no DOM) ------------------------------------

// Direct tools (no drawer). Ids match the tool string passed to onTool.
const DIRECT_ROAD  = { id: 'road',     emoji: '🛣️', label: 'Road' };
const DIRECT_TREE  = { id: 'tree',     emoji: '🌳', label: 'Tree' };
const DIRECT_ERASE = { id: 'bulldoze', emoji: '🧹', label: 'Erase' };

// Category tabs (open drawers). key matches CATALOG keys.
const CATEGORY_TABS = [
  { key: 'homes',     emoji: '🏠', label: 'Homes' },
  { key: 'shops',     emoji: '🏪', label: 'Shops' },
  { key: 'factories', emoji: '🏭', label: 'Factories' },
  { key: 'fun',       emoji: '🎡', label: 'Fun' },
  { key: 'downtown',  emoji: '🏙️', label: 'Downtown' },
  { key: 'deco',      emoji: '🌼', label: 'Deco' },
];

// Sticker book section order + headers (label/emoji per catalog category).
const STICKER_SECTIONS = [
  { key: 'homes',     emoji: '🏠', label: 'Homes' },
  { key: 'shops',     emoji: '🏪', label: 'Shops' },
  { key: 'factories', emoji: '🏭', label: 'Factories' },
  { key: 'fun',       emoji: '🎡', label: 'Fun' },
  { key: 'downtown',  emoji: '🏙️', label: 'Downtown' },
  { key: 'deco',      emoji: '🌼', label: 'Deco' },
];

const CONFETTI_EMOJI = ['🎉', '⭐', '🎈', '✨', '🏆', '🌈', '🎊'];
const CONFETTI_COLORS = ['#ffb703', '#fb8500', '#8ecae6', '#219ebc', '#ff7096', '#90e0a0', '#c77dff'];

const SPRING = 'cubic-bezier(.34,1.56,.64,1)';

// crude sun/moon guess from a clock label string like "3:00 PM"
function dayIcon(clockLabel) {
  try {
    if (typeof clockLabel !== 'string') return '☀️';
    const low = clockLabel.toLowerCase();
    if (/(night|moon|evening|midnight)/.test(low)) return '🌙';
    const m = low.match(/(\d{1,2})(?::\d{2})?\s*(am|pm)?/);
    if (m) {
      let h = parseInt(m[1], 10);
      const mer = m[2];
      if (mer === 'pm' && h !== 12) h += 12;
      if (mer === 'am' && h === 12) h = 0;
      if (h < 6 || h >= 19) return '🌙';
    }
  } catch (_) { /* ignore */ }
  return '☀️';
}

function fmtNum(v) {
  const n = Math.round(typeof v === 'number' && isFinite(v) ? v : 0);
  try { return n.toLocaleString('en-US'); } catch (_) { return String(n); }
}

function clamp01(v) {
  const n = (typeof v === 'number' && isFinite(v)) ? v : 0;
  return n < 0 ? 0 : (n > 1 ? 1 : n);
}

// happiness face that morphs 😟 🙂 😀 🤩 by value (0..1)
function happyFace(v) {
  const x = clamp01(v);
  if (x < 0.3) return { em: '😟', word: 'sad', art: 'face-sad' };
  if (x < 0.55) return { em: '🙂', word: 'okay', art: 'face-ok' };
  if (x < 0.82) return { em: '😀', word: 'happy', art: 'face-happy' };
  return { em: '🤩', word: 'super happy', art: 'face-amazed' };
}

// ---- the stylesheet (string built at init, injected into <head>) ----------

const CSS = `
#bv-ui, #bv-ui * { box-sizing: border-box; }
#bv-ui {
  --bv-accent: #ffb703;
  --bv-accent-dark: #fb8500;
  --bv-text: #2b6a99;
  --bv-card: rgba(255,255,255,.82);
  --bv-card-solid: #ffffff;
  --bv-good: #2fbf71;
  --bv-bad: #ff5d5d;
  --bv-spring: ${SPRING};
  position: fixed; inset: 0;
  pointer-events: none;               /* map drags pass through by default */
  z-index: 2147483000;
  font-family: ui-rounded, "SF Pro Rounded", "Comic Sans MS", system-ui, -apple-system, sans-serif;
  color: var(--bv-text);
  -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
  overflow: hidden;
}
#bv-ui button { font-family: inherit; }

/* ---------- custom art icons ---------- */
/* An icon <img> sits in a .bv-glyph (buttons) or .bv-ic/.bv-em (stats/tabs) and
   scales to the glyph's font-size, so it drops in wherever an emoji lived. */
#bv-ui .bv-glyph { display: inline-flex; align-items: center; justify-content: center; line-height: 1; }
#bv-ui .bv-glyph-img { width: 1.42em; height: 1.42em; object-fit: contain; display: block; pointer-events: none; }
#bv-ui .bv-ic .bv-glyph-img { width: 1.35em; height: 1.35em; }
#bv-ui .bv-em .bv-glyph-img { width: 1.7em; height: 1.7em; }
#bv-ui .bv-bn-em .bv-glyph-img { width: 1.5em; height: 1.5em; }
#bv-ui .bv-step-em .bv-glyph-img { width: 1.2em; height: 1.2em; }
#bv-ui .bv-mode-em .bv-glyph-img { width: 2.4em; height: 2.4em; }
#bv-ui .bv-menu-overlay { background-size: cover; background-position: center; }
#bv-ui .bv-menu-logo { text-align: center; margin: -6px 0 2px; }
#bv-ui .bv-menu-logo img { width: min(340px, 70vw); height: auto; display: inline-block; filter: drop-shadow(0 4px 8px rgba(30,90,140,.25)); }

/* ---------- top bar ---------- */
.bv-top {
  position: absolute; left: 50%; transform: translateX(-50%);
  top: calc(10px + env(safe-area-inset-top, 0px));
  display: flex; align-items: center; gap: 14px;
  max-width: calc(100vw - 20px);
  padding: 8px 12px;
  background: var(--bv-card);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  backdrop-filter: blur(14px) saturate(1.4);
  border-radius: 26px;
  box-shadow: 0 8px 26px rgba(43,106,153,.20), inset 0 0 0 2px rgba(255,255,255,.6);
  pointer-events: auto;
  flex-wrap: nowrap;
  overflow-x: auto; overflow-y: hidden;
  scrollbar-width: none;
  touch-action: pan-x;
}
.bv-top::-webkit-scrollbar { display: none; }
.bv-stat {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 18px;
  white-space: nowrap; flex: 0 0 auto;
  transition: background .3s ease;
}
.bv-stat .bv-ic { font-size: 22px; line-height: 1; }
.bv-stat .bv-val { font-size: 20px; font-weight: 800; letter-spacing: .2px; }
.bv-stat.bv-flash-up { background: rgba(47,191,113,.22); }
.bv-day .bv-val { font-size: 16px; }
.bv-day .bv-sub { font-size: 12px; font-weight: 700; opacity: .7; margin-left: 4px; }

.bv-sep { width: 2px; height: 30px; background: rgba(43,106,153,.14); border-radius: 2px; flex: 0 0 auto; }

.bv-ctl-group { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; background: rgba(43,106,153,.08); padding: 4px; border-radius: 20px; }
.bv-ctl {
  width: 42px; height: 42px; min-width: 42px;
  border: none; border-radius: 16px; background: transparent;
  font-size: 20px; cursor: pointer; color: inherit;
  display: flex; align-items: center; justify-content: center;
  touch-action: manipulation;
  transition: transform .18s var(--bv-spring), background .18s ease;
}
.bv-ctl:active { transform: scale(.9); }
.bv-ctl.bv-on { background: var(--bv-accent); box-shadow: 0 4px 12px rgba(255,183,3,.5); }
.bv-btn-round {
  width: 46px; height: 46px; min-width: 46px;
  border: none; border-radius: 18px; background: var(--bv-card-solid);
  font-size: 22px; cursor: pointer; color: inherit;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 12px rgba(43,106,153,.16);
  touch-action: manipulation; flex: 0 0 auto;
  transition: transform .18s var(--bv-spring);
}
.bv-btn-round:active { transform: scale(.88); }

/* ---------- toasts ---------- */
.bv-toasts {
  position: absolute; left: 50%; transform: translateX(-50%);
  top: calc(74px + env(safe-area-inset-top, 0px));
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  width: max-content; max-width: calc(100vw - 24px);
  pointer-events: none;
}
.bv-toast {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 18px; border-radius: 22px;
  background: var(--bv-card-solid); color: var(--bv-text);
  font-size: 16px; font-weight: 800;
  box-shadow: 0 8px 22px rgba(43,106,153,.22), inset 0 0 0 2px var(--bv-accent);
  animation: bv-toast-in .35s var(--bv-spring) both;
  max-width: 90vw;
}
.bv-toast.bv-out { animation: bv-toast-out .3s ease forwards; }
.bv-toast .bv-t-em { font-size: 20px; }
@keyframes bv-toast-in { from { opacity: 0; transform: translateY(-14px) scale(.8); } to { opacity: 1; transform: none; } }
@keyframes bv-toast-out { to { opacity: 0; transform: translateY(-10px) scale(.85); } }

/* ---------- drawer (building cards) ---------- */
.bv-drawer {
  position: absolute; left: 0; right: 0;
  bottom: calc(92px + env(safe-area-inset-bottom, 0px));
  display: none;
  pointer-events: auto;
  padding: 0 calc(8px + env(safe-area-inset-right, 0px)) 0 calc(8px + env(safe-area-inset-left, 0px));
}
.bv-drawer.bv-open { display: block; }
.bv-drawer-inner {
  display: flex; align-items: stretch; gap: 8px;
  padding: 10px 12px;
  background: var(--bv-card);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  backdrop-filter: blur(14px) saturate(1.4);
  border-radius: 24px;
  box-shadow: 0 10px 30px rgba(43,106,153,.24), inset 0 0 0 2px rgba(255,255,255,.6);
}
.bv-drawer.bv-open .bv-drawer-inner { animation: bv-drawer-up .34s var(--bv-spring) both; }
@keyframes bv-drawer-up { from { opacity: 0; transform: translateY(24px) scale(.96); } to { opacity: 1; transform: none; } }
.bv-drawer-close {
  flex: 0 0 auto; align-self: center;
  width: 40px; height: 40px; min-width: 40px;
  border: none; border-radius: 14px; background: var(--bv-card-solid); color: inherit;
  font-size: 18px; font-weight: 900; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 3px 10px rgba(43,106,153,.16);
  touch-action: manipulation;
  transition: transform .18s var(--bv-spring);
}
.bv-drawer-close:active { transform: scale(.88); }
.bv-drawer-strip {
  display: flex; gap: 8px;
  overflow-x: auto; overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  touch-action: pan-x;
  flex: 1 1 auto;
}
.bv-drawer-strip::-webkit-scrollbar { display: none; }
.bv-card-btn {
  position: relative; flex: 0 0 auto;
  width: 72px; min-width: 72px; height: 72px; min-height: 64px;
  border: none; border-radius: 18px;
  background: var(--bv-card-solid); color: var(--bv-text);
  cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px; padding: 4px;
  box-shadow: 0 4px 12px rgba(43,106,153,.16);
  touch-action: manipulation;
  transition: transform .2s var(--bv-spring), box-shadow .2s ease;
}
.bv-card-btn:active { transform: scale(.92); }
.bv-card-btn .bv-c-em { font-size: 30px; line-height: 1; }
.bv-card-btn .bv-c-lbl {
  font-size: 10px; font-weight: 800; letter-spacing: .1px; line-height: 1.05;
  max-width: 66px; text-align: center;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bv-card-btn .bv-c-size {
  position: absolute; top: -5px; right: -4px;
  background: var(--bv-text); color: #fff;
  font-size: 9px; font-weight: 900; line-height: 1;
  padding: 3px 5px; border-radius: 9px;
  box-shadow: 0 2px 5px rgba(0,0,0,.2);
}
.bv-card-btn.bv-active {
  transform: translateY(-4px) scale(1.06);
  box-shadow: 0 10px 22px rgba(255,183,3,.5), inset 0 0 0 4px var(--bv-accent);
}
.bv-drawer-empty { padding: 18px 12px; font-size: 13px; font-weight: 800; opacity: .7; }

/* ---------- toolbar (category + direct tabs) ---------- */
.bv-toolbar {
  position: absolute; left: 0; right: 0;
  bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  display: flex; gap: 8px;
  padding: 8px calc(12px + env(safe-area-inset-right, 0px)) 8px calc(12px + env(safe-area-inset-left, 0px));
  overflow-x: auto; overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  pointer-events: auto;
  touch-action: pan-x;
}
.bv-toolbar::-webkit-scrollbar { display: none; }
.bv-tool {
  position: relative; flex: 0 0 auto;
  width: 68px; height: 68px; min-width: 68px; min-height: 60px;
  border: none; border-radius: 20px;
  background: var(--bv-card-solid); color: var(--bv-text);
  cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px; padding-top: 4px;
  box-shadow: 0 5px 14px rgba(43,106,153,.16);
  touch-action: manipulation;
  transition: transform .2s var(--bv-spring), box-shadow .2s ease;
}
.bv-tool:active { transform: scale(.92); }
.bv-tool .bv-em { font-size: 30px; line-height: 1; }
.bv-tool .bv-lbl { font-size: 11px; font-weight: 800; letter-spacing: .2px; }
/* a direct tool is the active one */
.bv-tool.bv-active {
  transform: translateY(-8px) scale(1.06);
  box-shadow: 0 10px 22px rgba(255,183,3,.5), inset 0 0 0 4px var(--bv-accent);
  animation: bv-bounce 1.1s var(--bv-spring) infinite;
}
/* a category tab whose drawer is open (raised, calmer than active) */
.bv-tool.bv-open-tab {
  transform: translateY(-8px) scale(1.04);
  box-shadow: 0 10px 22px rgba(33,158,188,.4), inset 0 0 0 4px #8ecae6;
}
@keyframes bv-bounce {
  0%,100% { transform: translateY(-8px) scale(1.06); }
  50% { transform: translateY(-13px) scale(1.06); }
}
.bv-wobble { animation: bv-wobble .5s ease; }
@keyframes bv-wobble {
  0%,100% { transform: rotate(0); }
  20% { transform: rotate(-9deg); }
  40% { transform: rotate(8deg); }
  60% { transform: rotate(-6deg); }
  80% { transform: rotate(4deg); }
}

/* ---------- modal overlays (welcome / confirm) ---------- */
.bv-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  background: rgba(43,106,153,.28);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  pointer-events: auto;
  animation: bv-fade .25s ease both;
}
@keyframes bv-fade { from { opacity: 0; } to { opacity: 1; } }
.bv-card {
  background: var(--bv-card-solid); color: var(--bv-text);
  border-radius: 28px; padding: 26px 24px;
  max-width: 420px; width: 100%;
  box-shadow: 0 20px 60px rgba(43,106,153,.35), inset 0 0 0 3px rgba(255,183,3,.25);
  text-align: center;
  animation: bv-pop .4s var(--bv-spring) both;
  max-height: calc(100vh - 40px); overflow-y: auto;
}
@keyframes bv-pop { from { opacity: 0; transform: scale(.7) translateY(20px); } to { opacity: 1; transform: none; } }
.bv-card h2 { margin: 0 0 6px; font-size: 26px; font-weight: 900; }
.bv-card p { margin: 0 0 16px; font-size: 15px; font-weight: 600; opacity: .85; }
.bv-steps { display: flex; flex-direction: column; gap: 12px; margin: 4px 0 18px; text-align: left; }
.bv-step { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: rgba(142,202,230,.18); border-radius: 18px; }
.bv-step .bv-step-em { font-size: 30px; }
.bv-step .bv-step-tx { font-size: 15px; font-weight: 800; }
.bv-hint { font-size: 13px; font-weight: 700; opacity: .7; margin: 0 0 16px; }
.bv-cta {
  border: none; cursor: pointer; color: #fff;
  font-size: 19px; font-weight: 900;
  padding: 14px 26px; border-radius: 20px; width: 100%;
  min-height: 56px;
  background: linear-gradient(135deg, var(--bv-accent), var(--bv-accent-dark));
  box-shadow: 0 8px 20px rgba(251,133,0,.45);
  touch-action: manipulation;
  transition: transform .18s var(--bv-spring);
}
.bv-cta:active { transform: scale(.95); }
.bv-choices { display: flex; gap: 12px; }
.bv-choices .bv-cta { width: auto; flex: 1; }
.bv-cta.bv-soft {
  background: #eef4f8; color: var(--bv-text);
  box-shadow: 0 6px 16px rgba(43,106,153,.16);
}

/* ---------- celebrate ---------- */
.bv-celebrate {
  position: absolute; left: 50%; transform: translateX(-50%);
  top: calc(90px + env(safe-area-inset-top, 0px));
  pointer-events: none;
  background: linear-gradient(135deg, #fff, #fff7e6);
  border-radius: 26px; padding: 16px 30px; text-align: center;
  box-shadow: 0 16px 40px rgba(255,183,3,.4), inset 0 0 0 3px var(--bv-accent);
  animation: bv-cele-in .5s var(--bv-spring) both;
  max-width: 90vw;
}
.bv-celebrate.bv-out { animation: bv-cele-out .4s ease forwards; }
.bv-celebrate .bv-cele-title { font-size: 26px; font-weight: 900; }
.bv-celebrate .bv-cele-sub { font-size: 15px; font-weight: 700; opacity: .8; margin-top: 2px; }
@keyframes bv-cele-in { from { opacity: 0; transform: translateX(-50%) translateY(-24px) scale(.6); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
@keyframes bv-cele-out { to { opacity: 0; transform: translateX(-50%) translateY(-16px) scale(.85); } }

.bv-confetti-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.bv-confetti { position: absolute; will-change: transform; }
.bv-confetti.sq { border-radius: 3px; }

@media (max-width: 900px) {
  .bv-top { gap: 6px; padding: 6px 8px; }
  .bv-stat { padding: 2px 6px; gap: 4px; }
  .bv-stat .bv-ic { font-size: 18px; }
  .bv-stat .bv-val { font-size: 16px; }
  .bv-day .bv-sub { display: none; }
}
/* ---------- sticker book ---------- */
.bv-sticker-card { max-width: 640px; text-align: center; }
.bv-sticker-head { font-size: 15px; font-weight: 900; opacity: .8; margin: 0 0 14px; }
.bv-sticker-scroll {
  max-height: min(66vh, 560px); overflow-y: auto;
  -webkit-overflow-scrolling: touch; touch-action: pan-y;
  margin: 0 -6px; padding: 0 6px;
}
.bv-sticker-scroll::-webkit-scrollbar { width: 8px; }
.bv-sticker-scroll::-webkit-scrollbar-thumb { background: rgba(43,106,153,.25); border-radius: 8px; }
.bv-sticker-sec { margin: 0 0 16px; }
.bv-sticker-sec-title {
  display: flex; align-items: center; gap: 8px; justify-content: flex-start;
  font-size: 17px; font-weight: 900; margin: 0 2px 8px; padding: 4px 2px;
  border-bottom: 3px dashed rgba(142,202,230,.6);
}
.bv-sticker-sec-title .bv-ss-em { font-size: 22px; }
.bv-sticker-sec-title .bv-ss-count { margin-left: auto; font-size: 13px; font-weight: 800; opacity: .6; }
.bv-sticker-grid {
  display: grid; gap: 8px;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
}
.bv-cell {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; padding: 8px 4px; border-radius: 16px; min-height: 82px;
  background: rgba(142,202,230,.14);
}
.bv-cell .bv-cell-em { font-size: 34px; line-height: 1; }
.bv-cell .bv-cell-lbl {
  font-size: 10px; font-weight: 800; line-height: 1.1;
  max-width: 78px; text-align: center;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bv-cell.bv-got {
  background: rgba(255,183,3,.16); box-shadow: inset 0 0 0 2px rgba(255,183,3,.5);
}
.bv-cell.bv-got .bv-cell-em { animation: bv-sticker-pop .4s var(--bv-spring) both; }
.bv-cell.bv-got .bv-cell-lbl { color: var(--bv-accent-dark); }
.bv-cell.bv-locked .bv-cell-em { filter: grayscale(1); opacity: .4; }
.bv-cell.bv-locked .bv-cell-lbl { opacity: .5; }
@keyframes bv-sticker-pop { from { transform: scale(.3); opacity: 0; } 60% { transform: scale(1.18); } to { transform: scale(1); opacity: 1; } }

/* ---------- postcard ---------- */
.bv-postcard-ov { flex-direction: column; gap: 16px; }
.bv-postcard-banner {
  background: linear-gradient(135deg, #fff, #fff7e6); color: var(--bv-text);
  border-radius: 22px; padding: 12px 24px; font-size: 22px; font-weight: 900;
  box-shadow: 0 12px 30px rgba(255,183,3,.4), inset 0 0 0 3px var(--bv-accent);
  animation: bv-banner-bounce 1.4s var(--bv-spring) infinite;
  max-width: 90vw; text-align: center;
}
@keyframes bv-banner-bounce {
  0%,100% { transform: translateY(0) rotate(-1.5deg); }
  50% { transform: translateY(-8px) rotate(1.5deg); }
}
.bv-postcard-frame {
  background: #fff; padding: 14px 14px 18px; border-radius: 10px;
  box-shadow: 0 22px 55px rgba(43,106,153,.45);
  transform: rotate(-2.5deg);
  max-width: 85vw;
}
.bv-postcard-frame img {
  display: block; max-height: 70vh; max-width: 100%;
  width: auto; object-fit: contain; border-radius: 4px;
  background: #eef4f8;
}
.bv-postcard-hint { font-size: 13px; font-weight: 700; color: #fff; opacity: .95; margin: 0; text-align: center; }
.bv-postcard-btns { display: flex; gap: 12px; align-items: center; }
.bv-save-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  text-decoration: none; color: #fff;
  font-size: 18px; font-weight: 900; padding: 14px 28px; border-radius: 20px;
  min-height: 54px; cursor: pointer;
  background: linear-gradient(135deg, var(--bv-accent), var(--bv-accent-dark));
  box-shadow: 0 8px 20px rgba(251,133,0,.45);
  transition: transform .18s var(--bv-spring);
}
.bv-save-btn:active { transform: scale(.94); }
.bv-close-btn {
  width: 54px; height: 54px; min-width: 54px; border: none; cursor: pointer;
  border-radius: 20px; background: var(--bv-card-solid); color: var(--bv-text);
  font-size: 24px; font-weight: 900;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 8px 20px rgba(43,106,153,.24);
  touch-action: manipulation;
  transition: transform .18s var(--bv-spring);
}
.bv-close-btn:active { transform: scale(.9); }

/* ---------- city name dialog ---------- */
.bv-name-input {
  width: 100%; margin: 4px 0 18px; padding: 14px 16px;
  border: 3px solid rgba(142,202,230,.6); border-radius: 18px;
  font-family: inherit; font-size: 22px; font-weight: 800; text-align: center;
  color: var(--bv-text); background: #f7fbfd; outline: none;
  -webkit-user-select: text; user-select: text;
}
.bv-name-input:focus { border-color: var(--bv-accent); }

/* ---------- extra HUD stats: jobs / happiness / air ---------- */
.bv-happy .bv-ic { font-size: 24px; }
.bv-air { gap: 6px; }
.bv-air-bar {
  width: 46px; height: 12px; border-radius: 7px;
  background: rgba(43,106,153,.16); overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(43,106,153,.12);
}
.bv-air-fill {
  display: block; height: 100%; width: 100%;
  background: linear-gradient(90deg, #ffb703, #2fbf71);
  border-radius: 7px;
  transition: width .45s ease;
}

/* ---------- top-bar toggle pressed ---------- */
.bv-btn-round.bv-on {
  background: var(--bv-accent);
  box-shadow: 0 4px 14px rgba(255,183,3,.55), inset 0 0 0 2px rgba(255,255,255,.55);
}

/* ---------- selected-tool banner ---------- */
.bv-banner {
  position: absolute; left: 50%; transform: translateX(-50%);
  top: calc(70px + env(safe-area-inset-top, 0px));
  display: none; align-items: center; gap: 10px;
  padding: 8px 20px 8px 14px; border-radius: 22px;
  background: linear-gradient(135deg, #fff, #fff7e6); color: var(--bv-text);
  box-shadow: 0 8px 22px rgba(255,183,3,.34), inset 0 0 0 2px var(--bv-accent);
  pointer-events: none; max-width: 82vw; z-index: 3;
}
.bv-banner.bv-show { display: flex; animation: bv-banner-pop .3s var(--bv-spring) both; }
.bv-banner .bv-bn-em { font-size: 30px; line-height: 1; }
.bv-banner .bv-bn-nm { font-size: 18px; font-weight: 900; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@keyframes bv-banner-pop { from { opacity: 0; transform: translateX(-50%) translateY(-8px) scale(.8); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
#bv-ui.bv-banner-on .bv-toasts { top: calc(124px + env(safe-area-inset-top, 0px)); }

/* ---------- red blocked toast ---------- */
.bv-toast.bv-toast-blocked {
  background: linear-gradient(135deg, #ff6b6b, #ff5d5d); color: #fff;
  box-shadow: 0 8px 22px rgba(255,93,93,.42), inset 0 0 0 2px rgba(255,255,255,.4);
  animation: bv-blocked-in .32s var(--bv-spring) both;
}
@keyframes bv-blocked-in { 0% { opacity: 0; transform: translateY(-10px) scale(.8); } 60% { transform: scale(1.06); } 100% { opacity: 1; transform: none; } }

/* ---------- favorites row ---------- */
.bv-favs {
  position: absolute; left: 0; right: 0;
  bottom: calc(96px + env(safe-area-inset-bottom, 0px));
  display: none; align-items: center; gap: 8px;
  padding: 0 calc(12px + env(safe-area-inset-right,0px)) 0 calc(12px + env(safe-area-inset-left,0px));
  pointer-events: none;
}
.bv-favs.bv-show { display: flex; }
.bv-favs-tag { flex: 0 0 auto; font-size: 13px; font-weight: 900; opacity: .85; }
.bv-favs-strip {
  display: flex; gap: 6px; overflow-x: auto; overflow-y: hidden;
  scrollbar-width: none; touch-action: pan-x; pointer-events: auto; padding: 2px;
}
.bv-favs-strip::-webkit-scrollbar { display: none; }
.bv-fav-btn {
  flex: 0 0 auto; width: 52px; height: 52px; border: none; border-radius: 15px;
  background: var(--bv-card-solid); color: var(--bv-text); cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  box-shadow: 0 3px 9px rgba(43,106,153,.16); touch-action: manipulation;
  transition: transform .18s var(--bv-spring);
}
.bv-fav-btn:active { transform: scale(.9); }
.bv-fav-btn .bv-fav-em { font-size: 24px; line-height: 1; }
.bv-fav-btn .bv-fav-lbl { font-size: 8px; font-weight: 800; max-width: 48px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#bv-ui.bv-fav-on .bv-drawer { bottom: calc(160px + env(safe-area-inset-bottom, 0px)); }

/* ---------- drawer scroll affordance ---------- */
.bv-strip-wrap { position: relative; flex: 1 1 auto; min-width: 0; display: flex; }
.bv-strip-fade { position: absolute; top: 0; bottom: 0; width: 34px; pointer-events: none; opacity: 0; transition: opacity .2s ease; z-index: 2; }
.bv-strip-fade.l { left: 0; background: linear-gradient(to right, rgba(255,255,255,.92), rgba(255,255,255,0)); }
.bv-strip-fade.r { right: 0; background: linear-gradient(to left, rgba(255,255,255,.92), rgba(255,255,255,0)); }
.bv-strip-fade.bv-show { opacity: 1; }
.bv-drawer-arrow {
  flex: 0 0 auto; align-self: center; width: 34px; height: 34px; min-width: 34px;
  border: none; border-radius: 12px; background: var(--bv-card-solid); color: inherit;
  font-size: 16px; font-weight: 900; cursor: pointer; display: none;
  align-items: center; justify-content: center;
  box-shadow: 0 3px 10px rgba(43,106,153,.18); touch-action: manipulation;
  transition: transform .15s var(--bv-spring), opacity .2s ease;
}
.bv-drawer-arrow.bv-show { display: flex; }
.bv-drawer-arrow:active { transform: scale(.85); }
.bv-drawer-arrow[disabled] { opacity: .28; cursor: default; }
.bv-swipe-hint {
  position: absolute; left: 50%; transform: translateX(-50%);
  top: -34px; padding: 6px 14px; border-radius: 16px;
  background: var(--bv-text); color: #fff; font-size: 13px; font-weight: 800;
  box-shadow: 0 6px 16px rgba(43,106,153,.3); pointer-events: none; z-index: 4;
  animation: bv-hint-bob 1s ease infinite;
}
@keyframes bv-hint-bob { 0%,100% { transform: translateX(-50%); } 50% { transform: translateX(-42%); } }

/* ---------- city helper (mission) card ---------- */
.bv-mission {
  position: absolute; left: calc(10px + env(safe-area-inset-left,0px));
  bottom: calc(100px + env(safe-area-inset-bottom, 0px));
  width: min(300px, calc(100vw - 24px));
  display: none; flex-direction: column; gap: 8px;
  padding: 14px; border-radius: 22px;
  background: var(--bv-card-solid); color: var(--bv-text);
  box-shadow: 0 12px 30px rgba(43,106,153,.26), inset 0 0 0 2px rgba(142,202,230,.5);
  pointer-events: none;               /* container never blocks map drags */
  z-index: 2;
}
.bv-mission.bv-show { display: flex; animation: bv-mission-in .34s var(--bv-spring) both; }
.bv-mission.bv-complete { box-shadow: 0 14px 34px rgba(255,183,3,.4), inset 0 0 0 3px var(--bv-accent); }
@keyframes bv-mission-in { from { opacity: 0; transform: translateX(-14px) scale(.94); } to { opacity: 1; transform: none; } }
.bv-mission-top { display: flex; align-items: center; gap: 10px; }
.bv-mission-em { font-size: 38px; line-height: 1; flex: 0 0 auto; }
.bv-mission-title { font-size: 17px; font-weight: 900; line-height: 1.12; }
.bv-mission-row { display: flex; align-items: center; gap: 8px; }
.bv-mission-say {
  flex: 0 0 auto; width: 38px; height: 38px; border: none; border-radius: 13px;
  background: rgba(142,202,230,.25); color: inherit; font-size: 18px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; pointer-events: auto;
  touch-action: manipulation; transition: transform .16s var(--bv-spring);
}
.bv-mission-say:active { transform: scale(.88); }
.bv-mission-prog-tx { font-size: 13px; font-weight: 800; opacity: .8; }
.bv-mission-bar { flex: 1 1 auto; height: 12px; border-radius: 7px; background: rgba(43,106,153,.14); overflow: hidden; }
.bv-mission-fill { height: 100%; width: 0%; border-radius: 7px; background: linear-gradient(90deg, var(--bv-accent), var(--bv-accent-dark)); transition: width .4s var(--bv-spring); }
.bv-mission.bv-complete .bv-mission-fill { background: linear-gradient(90deg, #2fbf71, #8ecae6); }
.bv-mission-ask { font-size: 14px; font-weight: 700; opacity: .9; margin: 2px 0; display: none; }
.bv-mission.bv-complete .bv-mission-ask { display: block; }
.bv-mission-btns { display: flex; gap: 8px; pointer-events: auto; }
.bv-mission-btn {
  flex: 1 1 auto; border: none; cursor: pointer; border-radius: 14px;
  font-size: 14px; font-weight: 900; padding: 10px 8px; min-height: 44px;
  color: var(--bv-text); background: #eef4f8; pointer-events: auto;
  touch-action: manipulation; transition: transform .16s var(--bv-spring);
}
.bv-mission-btn.bv-primary { color: #fff; background: linear-gradient(135deg, var(--bv-accent), var(--bv-accent-dark)); box-shadow: 0 6px 16px rgba(251,133,0,.4); }
.bv-mission-btn:active { transform: scale(.94); }
.bv-mission-next { display: none; }
.bv-mission.bv-complete .bv-mission-next { display: block; }

/* ---------- mode picker ---------- */
.bv-mode-card { max-width: 580px; }
.bv-mode-grid { display: flex; flex-direction: column; gap: 12px; margin: 6px 0 4px; }
@media (min-width: 640px) { .bv-mode-grid { flex-direction: row; } }
.bv-mode-opt {
  flex: 1 1 0; border: none; cursor: pointer; border-radius: 22px;
  background: rgba(142,202,230,.16); color: var(--bv-text);
  padding: 20px 14px; text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  box-shadow: inset 0 0 0 2px rgba(142,202,230,.4);
  touch-action: manipulation; transition: transform .18s var(--bv-spring), box-shadow .18s ease;
}
.bv-mode-opt:active { transform: scale(.95); }
.bv-mode-opt:hover, .bv-mode-opt:focus-visible { box-shadow: inset 0 0 0 3px var(--bv-accent); outline: none; }
.bv-mode-opt .bv-mode-em { font-size: 44px; line-height: 1; }
.bv-mode-opt .bv-mode-nm { font-size: 18px; font-weight: 900; }
.bv-mode-opt .bv-mode-age { font-size: 13px; font-weight: 700; opacity: .7; }

/* ---------- picture-play simple bar ---------- */
.bv-picbar {
  position: absolute; left: 0; right: 0;
  bottom: calc(10px + env(safe-area-inset-bottom,0px));
  display: none; align-items: center; justify-content: center; gap: 10px;
  padding: 10px calc(12px + env(safe-area-inset-right,0px)) 10px calc(12px + env(safe-area-inset-left,0px));
  overflow-x: auto; scrollbar-width: none; touch-action: pan-x; pointer-events: auto;
}
.bv-picbar::-webkit-scrollbar { display: none; }
.bv-picbar.bv-show { display: flex; }
.bv-pic-btn {
  flex: 0 0 auto; width: 84px; height: 84px; border: none; border-radius: 24px;
  background: var(--bv-card-solid); color: var(--bv-text); cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  box-shadow: 0 6px 16px rgba(43,106,153,.18); touch-action: manipulation;
  transition: transform .2s var(--bv-spring), box-shadow .2s ease;
}
.bv-pic-btn:active { transform: scale(.92); }
.bv-pic-btn.bv-active { transform: translateY(-6px) scale(1.06); box-shadow: 0 12px 24px rgba(255,183,3,.5), inset 0 0 0 4px var(--bv-accent); }
.bv-pic-btn .bv-pic-em { font-size: 40px; line-height: 1; }
.bv-pic-btn .bv-pic-lbl { font-size: 12px; font-weight: 900; }
/* picture mode hides the complex toolbar bits */
#bv-ui.bv-mode-picture .bv-toolbar,
#bv-ui.bv-mode-picture .bv-drawer,
#bv-ui.bv-mode-picture .bv-favs { display: none !important; }

/* ---------- city manager ---------- */
.bv-cities-card { max-width: 520px; text-align: left; }
.bv-cities-list { display: flex; flex-direction: column; gap: 10px; margin: 6px 0 16px; max-height: 50vh; overflow-y: auto; }
.bv-city-row { display: flex; align-items: center; gap: 10px; padding: 12px; background: rgba(142,202,230,.16); border-radius: 18px; }
.bv-city-row.bv-current { box-shadow: inset 0 0 0 2px var(--bv-accent); }
.bv-city-info { flex: 1 1 auto; min-width: 0; }
.bv-city-name { font-size: 17px; font-weight: 900; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bv-city-sub { font-size: 12px; font-weight: 700; opacity: .7; }
.bv-city-acts { display: flex; gap: 6px; flex: 0 0 auto; }
.bv-city-act {
  width: 40px; height: 40px; border: none; border-radius: 13px; cursor: pointer;
  background: var(--bv-card-solid); color: inherit; font-size: 18px;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 3px 9px rgba(43,106,153,.16); touch-action: manipulation;
  transition: transform .15s var(--bv-spring);
}
.bv-city-act:active { transform: scale(.88); }
.bv-city-current-tag { font-size: 12px; font-weight: 900; color: var(--bv-accent-dark); flex: 0 0 auto; }

/* ---------- screen-reader-only live region ---------- */
.bv-sr {
  position: absolute !important; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0);
  white-space: nowrap; border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .bv-tool.bv-active { animation: none; }
  .bv-drawer.bv-open .bv-drawer-inner { animation: none; }
  .bv-postcard-banner { animation: none; }
  .bv-cell.bv-got .bv-cell-em { animation: none; }
  .bv-banner.bv-show { animation: none; }
  .bv-mission.bv-show { animation: none; }
  .bv-toast.bv-toast-blocked { animation: none; }
  .bv-swipe-hint { animation: none; }
}
`;

// ---- main entry -----------------------------------------------------------

export function initUI(hooks) {
  const h = hooks || {};
  const call = (fn, ...a) => { try { if (typeof fn === 'function') fn(...a); } catch (_) { /* swallow */ } };

  // If there's no DOM (e.g. imported in Node), hand back a harmless stub so
  // callers never crash.
  if (typeof document === 'undefined' || !document.head || !document.body) {
    const noop = () => {};
    return {
      setStats: noop, setCatalog: noop, setActiveTool: noop,
      setStickers: noop, showStickerBook: noop,
      showPostcard: noop, askCityName: (_c, cb) => { try { if (typeof cb === 'function') cb('Blockville'); } catch (_) { /* ignore */ } },
      toast: noop, celebrate: noop, showWelcome: noop, destroy: noop,
      // v3.3 additions — all harmless no-ops without a DOM
      showModePicker: noop, setMode: noop, showBlocked: noop,
      setFavorites: noop, setMission: noop, hideMission: noop,
      showCityManager: noop, announce: noop,
    };
  }

  // ---- inject stylesheet once ----
  if (!document.getElementById('bv-ui-style')) {
    const st = document.createElement('style');
    st.id = 'bv-ui-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // small DOM helper
  function el(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  // icon-only button factory — always carries an aria-label
  // Render an icon into `container` as a custom-art <img> keyed by `key`, with
  // the emoji as automatic fallback (missing art, or the image failing to load).
  function setGlyph(container, key, emoji) {
    if (!container) return;
    container.textContent = '';
    const url = (ART && key) ? ART[key] : null;
    if (url) {
      const img = document.createElement('img');
      img.className = 'bv-glyph-img';
      img.src = url; img.alt = ''; img.draggable = false;
      img.setAttribute('aria-hidden', 'true');
      img.addEventListener('error', () => { container.textContent = emoji || ''; });
      container.appendChild(img);
    } else {
      container.textContent = emoji || '';
    }
  }

  function iconBtn(cls, glyph, ariaLabel, title, artKey) {
    const b = el('button', cls);
    b.type = 'button';
    const g = el('span', 'bv-glyph');
    setGlyph(g, artKey, glyph);
    b.appendChild(g);
    b._glyph = g; b._emoji = glyph;   // toggles swap art via setGlyph(b._glyph, …)
    b.setAttribute('aria-label', ariaLabel);
    b.title = title || ariaLabel;
    return b;
  }

  // ---- accessible dialog controller: focus-in, Tab-trap, Escape, focus-restore ----
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function getFocusable(container) {
    try { return Array.prototype.slice.call(container.querySelectorAll(FOCUSABLE)); }
    catch (_) { return []; }
  }
  // ov = overlay backdrop, card = the modal panel, closeFn = how to dismiss it.
  function makeDialog(ov, card, closeFn, opts) {
    const o = opts || {};
    try {
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      if (o.label) card.setAttribute('aria-label', o.label);
      if (card.tabIndex < 0) card.tabIndex = -1;
    } catch (_) { /* ignore */ }
    const prevFocus = (() => { try { return document.activeElement; } catch (_) { return null; } })();
    function onKey(e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        try { closeFn(); } catch (_) { /* ignore */ }
        return;
      }
      if (e.key === 'Tab') {
        const items = getFocusable(card);
        if (!items.length) { e.preventDefault(); try { card.focus(); } catch (_) { /* ignore */ } return; }
        const first = items[0], last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !card.contains(active)) { e.preventDefault(); try { last.focus(); } catch (_) { /* ignore */ } }
        } else {
          if (active === last || !card.contains(active)) { e.preventDefault(); try { first.focus(); } catch (_) { /* ignore */ } }
        }
      }
    }
    ov.addEventListener('keydown', onKey);
    setTimeout(() => {
      try {
        const target = o.initialFocus || getFocusable(card)[0] || card;
        if (target && typeof target.focus === 'function') target.focus();
      } catch (_) { /* ignore */ }
    }, 30);
    return {
      dispose() {
        try { ov.removeEventListener('keydown', onKey); } catch (_) { /* ignore */ }
        try {
          if (prevFocus && typeof prevFocus.focus === 'function' &&
              (typeof document.contains !== 'function' || document.contains(prevFocus))) {
            prevFocus.focus();
          }
        } catch (_) { /* ignore */ }
      },
    };
  }

  // set a toggle button's pressed visual + aria-pressed
  function setPressed(btn, on) {
    if (!btn) return;
    btn.classList.toggle('bv-on', !!on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // remove any stale root from a previous init
  const old = document.getElementById('bv-ui');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  const root = el('div');
  root.id = 'bv-ui';

  // ===== TOP BAR =====
  const top = el('div', 'bv-top');

  function makeStat(cls, icon, val, artKey) {
    const s = el('div', 'bv-stat ' + cls);
    const ic = el('span', 'bv-ic');
    setGlyph(ic, artKey, icon);
    const v = el('span', 'bv-val', val);
    s.appendChild(ic); s.appendChild(v);
    return { root: s, ic, v };
  }

  const stPop = makeStat('bv-pop', '👥', '0', 'stat-people');
  stPop.root.setAttribute('aria-label', '0 people');

  // 💼 jobs — hidden until a jobs value is first supplied
  const stJobs = makeStat('bv-jobs', '💼', '0', 'stat-jobs');
  stJobs.root.style.display = 'none';
  stJobs.root.setAttribute('aria-label', '0 jobs');

  // 😀 happiness FACE — morphs 😟🙂😀🤩 by value; hidden until supplied
  const stHappy = el('div', 'bv-stat bv-happy');
  const happyIc = el('span', 'bv-ic');
  setGlyph(happyIc, 'face-ok', '🙂');
  happyIc.setAttribute('role', 'img');
  stHappy.appendChild(happyIc);
  stHappy.style.display = 'none';
  stHappy.setAttribute('aria-label', 'Happiness');

  // 🌿 air meter — small bar; hidden until supplied
  const stAir = el('div', 'bv-stat bv-air');
  const airIc = el('span', 'bv-ic'); setGlyph(airIc, 'stat-air', '🌿'); stAir.appendChild(airIc);
  const airBar = el('span', 'bv-air-bar');
  const airFill = el('span', 'bv-air-fill');
  airBar.appendChild(airFill);
  stAir.appendChild(airBar);
  stAir.style.display = 'none';
  stAir.setAttribute('aria-label', 'Clean air');

  // day stat: sun/moon icon + "Day n" + clock sublabel
  const stDay = el('div', 'bv-stat bv-day');
  const dayIc = el('span', 'bv-ic');
  setGlyph(dayIc, 'stat-day', '☀️');
  const dayVal = el('span', 'bv-val', 'Day 1');
  const daySub = el('span', 'bv-sub', '');
  stDay.appendChild(dayIc); stDay.appendChild(dayVal); stDay.appendChild(daySub);

  top.appendChild(stPop.root);
  top.appendChild(stJobs.root);
  top.appendChild(stHappy);
  top.appendChild(stAir);
  top.appendChild(stDay);
  top.appendChild(el('div', 'bv-sep'));

  // speed toggle group
  const speedGroup = el('div', 'bv-ctl-group');
  speedGroup.setAttribute('role', 'group');
  speedGroup.setAttribute('aria-label', 'Game speed');
  const speedBtns = {};
  [['Pause', 0, '⏸️', 'btn-pause'], ['Play', 1, '▶️', 'btn-play'], ['Fast forward', 3, '⏩', 'btn-fast']].forEach(([label, val, emo, key]) => {
    const b = el('button', 'bv-ctl');
    b.type = 'button';
    const g = el('span', 'bv-glyph'); setGlyph(g, key, emo); b.appendChild(g);
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', 'false');
    b.title = label;
    b.addEventListener('click', () => { setSpeedUI(val); call(h.onSpeed, val); });
    speedGroup.appendChild(b);
    speedBtns[val] = b;
  });
  top.appendChild(speedGroup);

  // 🔊 sound mute (distinct from the speech toggle below)
  const muteBtn = iconBtn('bv-btn-round', '🔊', 'Sound on', null, 'btn-sound-on');
  muteBtn.setAttribute('aria-pressed', 'false');
  let muted = false;
  muteBtn.addEventListener('click', () => {
    if (typeof h.onMute === 'function') {
      const r = (() => { try { return h.onMute(); } catch (_) { return undefined; } })();
      muted = (typeof r === 'boolean') ? r : !muted;
    } else {
      muted = !muted;
    }
    setGlyph(muteBtn._glyph, muted ? 'btn-sound-off' : 'btn-sound-on', muted ? '🔇' : '🔊');
    muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    muteBtn.setAttribute('aria-label', muted ? 'Sound off' : 'Sound on');
  });
  top.appendChild(muteBtn);

  const newBtn = iconBtn('bv-btn-round', '🆕', 'New city', null, 'btn-new-city');
  newBtn.addEventListener('click', showNewConfirm);
  top.appendChild(newBtn);

  top.appendChild(el('div', 'bv-sep'));

  // ↩️ undo — brief press animation, then fires onUndo
  const undoBtn = iconBtn('bv-btn-round', '↩️', 'Undo', null, 'btn-undo');
  undoBtn.addEventListener('click', () => {
    undoBtn.classList.remove('bv-wobble');
    void undoBtn.offsetWidth;
    undoBtn.classList.add('bv-wobble');
    setTimeout(() => undoBtn.classList.remove('bv-wobble'), 520);
    call(h.onUndo);
  });
  top.appendChild(undoBtn);

  // 📷 photo — snapshot / postcard
  const photoBtn = iconBtn('bv-btn-round', '📷', 'Take a photo', null, 'btn-photo');
  photoBtn.addEventListener('click', () => call(h.onPhoto));
  top.appendChild(photoBtn);

  // 📖 sticker book — opens the internal overlay
  const bookBtn = iconBtn('bv-btn-round', '📖', 'Sticker book', null, 'btn-sticker-book');
  bookBtn.addEventListener('click', () => showStickerBook());
  top.appendChild(bookBtn);

  top.appendChild(el('div', 'bv-sep'));

  // ❓ help — replays the welcome guide
  const helpBtn = iconBtn('bv-btn-round', '❓', 'Help', null, 'btn-help');
  helpBtn.addEventListener('click', () => call(h.onHelp));
  top.appendChild(helpBtn);

  // 🗣️ speech toggle (read-aloud) — separate from the sound mute; default OFF
  const speechBtn = iconBtn('bv-btn-round', '🗣️', 'Read aloud off', null, 'btn-readaloud-off');
  speechBtn.setAttribute('aria-pressed', 'false');
  let speechOn = false;
  speechBtn.addEventListener('click', () => {
    speechOn = !speechOn;
    setPressed(speechBtn, speechOn);
    setGlyph(speechBtn._glyph, speechOn ? 'btn-readaloud-on' : 'btn-readaloud-off', '🗣️');
    speechBtn.setAttribute('aria-label', speechOn ? 'Read aloud on' : 'Read aloud off');
    call(h.onSpeechToggle, speechOn);
  });
  top.appendChild(speechBtn);

  // ☀️ always-bright toggle — default OFF
  const brightBtn = iconBtn('bv-btn-round', '☀️', 'Always bright off', null, 'btn-bright-off');
  brightBtn.setAttribute('aria-pressed', 'false');
  let brightOn = false;
  brightBtn.addEventListener('click', () => {
    brightOn = !brightOn;
    setPressed(brightBtn, brightOn);
    setGlyph(brightBtn._glyph, brightOn ? 'btn-bright-on' : 'btn-bright-off', '☀️');
    brightBtn.setAttribute('aria-label', brightOn ? 'Always bright on' : 'Always bright off');
    call(h.onAlwaysBright, brightOn);
  });
  top.appendChild(brightBtn);

  // 🗂️ cities — main supplies the list via showCityManager()
  const citiesBtn = iconBtn('bv-btn-round', '🗂️', 'My cities', null, 'btn-cities');
  citiesBtn.addEventListener('click', () => call(h.onCities));
  top.appendChild(citiesBtn);

  root.appendChild(top);

  // ===== SELECTED-TOOL BANNER (floating under the top bar) =====
  const banner = el('div', 'bv-banner');
  const bannerEm = el('span', 'bv-bn-em', '');
  bannerEm.setAttribute('aria-hidden', 'true');
  const bannerNm = el('span', 'bv-bn-nm', '');
  banner.appendChild(bannerEm); banner.appendChild(bannerNm);
  root.appendChild(banner);

  // ===== POLITE LIVE REGION (single) =====
  const liveRegion = el('div', 'bv-sr');
  liveRegion.setAttribute('role', 'status');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  root.appendChild(liveRegion);
  function announce(text) {
    try {
      if (!text) return;
      liveRegion.textContent = '';
      // next tick so repeated identical messages still re-announce
      setTimeout(() => { try { liveRegion.textContent = String(text); } catch (_) { /* ignore */ } }, 40);
    } catch (_) { /* ignore */ }
  }

  // ===== TOASTS =====
  const toastLayer = el('div', 'bv-toasts');
  root.appendChild(toastLayer);

  // ===== DRAWER (building cards) =====
  const drawer = el('div', 'bv-drawer');
  const drawerInner = el('div', 'bv-drawer-inner');

  const arrowL = iconBtn('bv-drawer-arrow', '‹', 'Scroll left', null, 'arrow-left');
  const arrowR = iconBtn('bv-drawer-arrow', '›', 'Scroll right', null, 'arrow-right');

  const stripWrap = el('div', 'bv-strip-wrap');
  const fadeL = el('span', 'bv-strip-fade l');
  const fadeR = el('span', 'bv-strip-fade r');
  fadeL.setAttribute('aria-hidden', 'true');
  fadeR.setAttribute('aria-hidden', 'true');
  const drawerStrip = el('div', 'bv-drawer-strip');
  drawerStrip.setAttribute('role', 'list');
  stripWrap.appendChild(fadeL);
  stripWrap.appendChild(drawerStrip);
  stripWrap.appendChild(fadeR);

  const swipeHint = el('div', 'bv-swipe-hint', 'Swipe for more →');
  swipeHint.style.display = 'none';

  const drawerClose = iconBtn('bv-drawer-close', '✕', 'Close');
  drawerClose.addEventListener('click', () => closeDrawer(true));

  arrowL.addEventListener('click', () => scrollStrip(-1));
  arrowR.addEventListener('click', () => scrollStrip(1));

  drawerInner.appendChild(arrowL);
  drawerInner.appendChild(stripWrap);
  drawerInner.appendChild(arrowR);
  drawerInner.appendChild(drawerClose);
  drawer.appendChild(swipeHint);
  drawer.appendChild(drawerInner);
  drawerStrip.addEventListener('scroll', updateDrawerScrollUI);
  root.appendChild(drawer);

  // ===== FAVORITES ROW ("⭐ Recent") =====
  const favs = el('div', 'bv-favs');
  favs.setAttribute('aria-label', 'Recent buildings');
  const favsTag = el('span', 'bv-favs-tag', '⭐ Recent');
  const favsStrip = el('div', 'bv-favs-strip');
  favs.appendChild(favsTag);
  favs.appendChild(favsStrip);
  root.appendChild(favs);

  // ===== CITY HELPER (mission) CARD =====
  const mission = el('div', 'bv-mission');
  mission.setAttribute('role', 'region');
  mission.setAttribute('aria-label', 'City Helper');
  const misTop = el('div', 'bv-mission-top');
  const misEm = el('span', 'bv-mission-em', '🙂');
  misEm.setAttribute('aria-hidden', 'true');
  const misTitle = el('div', 'bv-mission-title', '');
  misTop.appendChild(misEm); misTop.appendChild(misTitle);
  const misRow = el('div', 'bv-mission-row');
  const misSay = iconBtn('bv-mission-say', '🔊', 'Say it again', null, 'helper-say-again');
  const misBar = el('div', 'bv-mission-bar');
  const misFill = el('span', 'bv-mission-fill');
  misBar.appendChild(misFill);
  const misProg = el('span', 'bv-mission-prog-tx', '');
  misRow.appendChild(misSay); misRow.appendChild(misProg); misRow.appendChild(misBar);
  const misAsk = el('div', 'bv-mission-ask', '');
  const misBtns = el('div', 'bv-mission-btns');
  const misFree = el('button', 'bv-mission-btn', 'Free Build');
  misFree.type = 'button';
  const misNext = el('button', 'bv-mission-btn bv-primary bv-mission-next', 'Next ▶');
  misNext.type = 'button';
  misBtns.appendChild(misFree); misBtns.appendChild(misNext);
  mission.appendChild(misTop);
  mission.appendChild(misRow);
  mission.appendChild(misAsk);
  mission.appendChild(misBtns);
  let missionSay = '';
  misSay.addEventListener('click', () => call(h.onSpeak, missionSay));
  misFree.addEventListener('click', () => call(h.onFreeBuild));
  misNext.addEventListener('click', () => call(h.onMissionNext));
  root.appendChild(mission);

  // ===== PICTURE-PLAY SIMPLE BAR =====
  const picbar = el('div', 'bv-picbar');
  picbar.setAttribute('role', 'toolbar');
  picbar.setAttribute('aria-label', 'Building blocks');
  root.appendChild(picbar);

  // ===== TOOLBAR =====
  const toolbar = el('div', 'bv-toolbar');
  const tabBtns = {};   // key/id -> button

  // Toolbar tab/tool → custom-art key. (Declared before the calls below so it's
  // not in the temporal dead zone when addDirectTool/addCategoryTab run.)
  const TAB_ART = {
    road: 'tool-road', tree: 'tool-tree', bulldoze: 'tool-erase',
    homes: 'tab-homes', shops: 'tab-shops', factories: 'tab-factories',
    fun: 'tab-fun', downtown: 'tab-downtown', deco: 'tab-deco',
  };

  // 🛣️ Road (direct)
  addDirectTool(DIRECT_ROAD);
  // category tabs
  CATEGORY_TABS.forEach(addCategoryTab);
  // 🌳 Tree + 🧹 Erase (direct)
  addDirectTool(DIRECT_TREE);
  addDirectTool(DIRECT_ERASE);

  function addDirectTool(t) {
    const b = el('button', 'bv-tool');
    b.type = 'button';
    b.dataset.tool = t.id;
    b.setAttribute('aria-label', t.label);
    b.setAttribute('aria-pressed', 'false');
    const em = el('span', 'bv-em'); setGlyph(em, TAB_ART[t.id], t.emoji); em.setAttribute('aria-hidden', 'true');
    b.appendChild(em);
    b.appendChild(el('span', 'bv-lbl', t.label));
    b.addEventListener('click', () => onDirectClick(t.id));
    toolbar.appendChild(b);
    tabBtns[t.id] = b;
  }

  function addCategoryTab(t) {
    const b = el('button', 'bv-tool');
    b.type = 'button';
    b.dataset.cat = t.key;
    b.setAttribute('aria-label', t.label + ' buildings');
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-haspopup', 'true');
    const em = el('span', 'bv-em'); setGlyph(em, TAB_ART[t.key], t.emoji); em.setAttribute('aria-hidden', 'true');
    b.appendChild(em);
    b.appendChild(el('span', 'bv-lbl', t.label));
    b.addEventListener('click', () => onCategoryClick(t.key));
    toolbar.appendChild(b);
    tabBtns[t.key] = b;
  }

  root.appendChild(toolbar);

  document.body.appendChild(root);

  // ---- state kept by the HUD ----
  let curSpeed = 1;
  let activeTool = null;   // null | 'road' | 'tree' | 'bulldoze' | entry object
  let openCat = null;      // currently open drawer category key or null
  let popDisplayed = null; // last shown pop number (updated every animation frame)
  let popTarget = null;    // value we're currently animating toward (or settled at)
  let popAnimId = 0;
  const catalog = {};      // key -> [entry...]
  const cardBtns = {};     // entry.id -> { btn, entry }
  let stickers = new Set();  // collected type ids (defensive copy of what's passed)
  let stickerOpen = false;   // is the sticker-book overlay currently showing?

  // apply initial visual states
  setSpeedUI(1);

  // ---------- speed ----------
  function setSpeedUI(v) {
    curSpeed = v;
    Object.keys(speedBtns).forEach((k) => {
      const on = String(k) === String(v);
      speedBtns[k].classList.toggle('bv-on', on);
      speedBtns[k].setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ---------- helpers: identify active tool ----------
  function activeEntryId() {
    return (activeTool && typeof activeTool === 'object') ? activeTool.id : null;
  }
  function activeDirectId() {
    return (typeof activeTool === 'string') ? activeTool : null;
  }
  // look up a friendly name for a catalog entry id (for announcements)
  function entryName(id) {
    if (id == null) return 'a building';
    if (cardBtns[id] && cardBtns[id].entry) return cardBtns[id].entry.name || String(id);
    let found = null;
    Object.keys(catalog).forEach((k) => {
      const list = catalog[k];
      if (Array.isArray(list)) list.forEach((e) => { if (e && String(e.id) === String(id)) found = e.name || String(id); });
    });
    return found || String(id);
  }

  // ---------- direct tool clicks ----------
  function onDirectClick(id) {
    if (activeDirectId() === id) {
      applyActive(null);
      call(h.onTool, null);
    } else {
      applyActive(id);
      call(h.onTool, id);
    }
  }

  // ---------- category tab clicks ----------
  function onCategoryClick(key) {
    if (openCat === key) {
      closeDrawer(true);
    } else {
      openDrawer(key);
    }
  }

  function openDrawer(key) {
    openCat = key;
    buildDrawerCards(key);
    drawer.classList.add('bv-open');
    // re-trigger the springy animation
    drawerInner.style.animation = 'none';
    void drawerInner.offsetWidth;
    drawerInner.style.animation = '';
    try { drawerStrip.scrollLeft = 0; } catch (_) { /* ignore */ }
    updateTabVisuals();
    // measure overflow after layout settles
    setTimeout(() => { updateDrawerScrollUI(); maybeShowSwipeHint(); }, 40);
  }

  // ---------- drawer scroll affordance ----------
  function scrollStrip(dir) {
    try {
      const amt = Math.max(120, Math.round(drawerStrip.clientWidth * 0.7));
      if (typeof drawerStrip.scrollBy === 'function') drawerStrip.scrollBy({ left: dir * amt, behavior: 'smooth' });
      else drawerStrip.scrollLeft += dir * amt;
    } catch (_) { /* ignore */ }
    setTimeout(updateDrawerScrollUI, 260);
  }

  function updateDrawerScrollUI() {
    try {
      const sl = drawerStrip.scrollLeft || 0;
      const overflow = drawerStrip.scrollWidth - drawerStrip.clientWidth;
      const canScroll = overflow > 4;
      const atStart = sl <= 2;
      const atEnd = sl >= overflow - 2;
      arrowL.classList.toggle('bv-show', canScroll);
      arrowR.classList.toggle('bv-show', canScroll);
      fadeL.classList.toggle('bv-show', canScroll && !atStart);
      fadeR.classList.toggle('bv-show', canScroll && !atEnd);
      if (atStart) arrowL.setAttribute('disabled', ''); else arrowL.removeAttribute('disabled');
      if (atEnd) arrowR.setAttribute('disabled', ''); else arrowR.removeAttribute('disabled');
    } catch (_) { /* ignore */ }
  }

  let swipeHintTimer = 0;
  let swipeHintShownSession = false;
  function swipeHintSeen() {
    try { return localStorage.getItem('bv-swipe-hint') === '1'; } catch (_) { return swipeHintShownSession; }
  }
  function maybeShowSwipeHint() {
    try {
      const overflow = drawerStrip.scrollWidth - drawerStrip.clientWidth;
      if (overflow <= 4) return;
      if (swipeHintSeen()) return;
      swipeHintShownSession = true;
      try { localStorage.setItem('bv-swipe-hint', '1'); } catch (_) { /* ignore */ }
      swipeHint.style.display = '';
      clearTimeout(swipeHintTimer);
      swipeHintTimer = setTimeout(hideSwipeHint, 2600);
    } catch (_) { /* ignore */ }
  }
  function hideSwipeHint() {
    try { swipeHint.style.display = 'none'; clearTimeout(swipeHintTimer); } catch (_) { /* ignore */ }
  }

  // closeFromControl: user hit ✕ (or tapped an open tab) — if the active tool
  // came from this drawer, deselect it too.
  function closeDrawer(closeFromControl) {
    drawer.classList.remove('bv-open');
    openCat = null;
    hideSwipeHint();
    if (closeFromControl && activeEntryId() != null) {
      applyActive(null);
      call(h.onTool, null);
    }
    updateTabVisuals();
  }

  function buildDrawerCards(key) {
    drawerStrip.textContent = '';
    const list = Array.isArray(catalog[key]) ? catalog[key] : [];
    if (!list.length) {
      drawerStrip.appendChild(el('div', 'bv-drawer-empty', 'No buildings yet'));
      return;
    }
    list.forEach((entry) => {
      if (!entry || entry.id == null) return;
      const b = el('button', 'bv-card-btn');
      b.type = 'button';
      b.dataset.entry = String(entry.id);
      b.setAttribute('role', 'listitem');
      b.setAttribute('aria-pressed', 'false');
      const em = el('span', 'bv-c-em', entry.emoji || '🏢'); em.setAttribute('aria-hidden', 'true');
      b.appendChild(em);
      b.appendChild(el('span', 'bv-c-lbl', entry.name || String(entry.id)));
      const tw = Math.max(1, Math.round(Number(entry.tw) || 1));
      const td = Math.max(1, Math.round(Number(entry.td) || 1));
      const sizeLabel = (tw > 1 || td > 1) ? (', ' + tw + ' by ' + td + ' big') : '';
      if (tw > 1 || td > 1) {
        b.appendChild(el('span', 'bv-c-size', tw + '×' + td));
      }
      b.setAttribute('aria-label', (entry.name || String(entry.id)) + sizeLabel);
      b.addEventListener('click', () => onCardClick(entry));
      drawerStrip.appendChild(b);
      cardBtns[entry.id] = { btn: b, entry };
    });
    updateCardVisuals();
  }

  function onCardClick(entry) {
    if (activeEntryId() === entry.id) {
      applyActive(null);
      call(h.onTool, null);
    } else {
      applyActive(entry);
      call(h.onTool, entry);
    }
  }

  // ---------- active-tool visuals ----------
  // Central setter: activeTool may be null, a direct id string, or an entry obj.
  function applyActive(tool) {
    activeTool = tool == null ? null : tool;
    updateTabVisuals();
    updateCardVisuals();
    updatePicVisuals();
    updateBanner();
  }

  function updateTabVisuals() {
    const dId = activeDirectId();
    Object.keys(tabBtns).forEach((k) => {
      const btn = tabBtns[k];
      // direct tool active highlight
      const isDirectActive = (dId != null && k === dId);
      btn.classList.toggle('bv-active', isDirectActive);
      // category tab: raised while its drawer is open
      const isOpenTab = (openCat != null && k === openCat);
      btn.classList.toggle('bv-open-tab', isOpenTab);
      if (btn.dataset.tool != null) btn.setAttribute('aria-pressed', isDirectActive ? 'true' : 'false');
      if (btn.dataset.cat != null) btn.setAttribute('aria-expanded', isOpenTab ? 'true' : 'false');
    });
  }

  function updateCardVisuals() {
    const eId = activeEntryId();
    Object.keys(cardBtns).forEach((id) => {
      const on = (id === eId);
      cardBtns[id].btn.classList.toggle('bv-active', on);
      cardBtns[id].btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ---------- picture-play button active reflection ----------
  const picBtns = {};   // item id -> { btn, item }
  function updatePicVisuals() {
    const dId = activeDirectId();
    const eId = activeEntryId();
    Object.keys(picBtns).forEach((id) => {
      const it = picBtns[id].item || {};
      const on = (it.kind === 'tool') ? (dId != null && String(it.id) === dId)
                                      : (eId != null && String(eId) === String(id));
      picBtns[id].btn.classList.toggle('bv-active', on);
      picBtns[id].btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ---------- selected-tool banner ----------
  function toolEmojiName(tool) {
    if (tool == null) return null;
    if (typeof tool === 'string') {
      if (tool === 'road') return { em: DIRECT_ROAD.emoji, nm: DIRECT_ROAD.label };
      if (tool === 'tree') return { em: DIRECT_TREE.emoji, nm: DIRECT_TREE.label };
      if (tool === 'bulldoze') return { em: DIRECT_ERASE.emoji, nm: DIRECT_ERASE.label };
      return { em: '🧱', nm: String(tool) };
    }
    if (typeof tool === 'object') {
      return { em: tool.emoji || '🏢', nm: tool.name || String(tool.id || '') };
    }
    return null;
  }
  function updateBanner() {
    const info = toolEmojiName(activeTool);
    if (!info) {
      banner.classList.remove('bv-show');
      root.classList.remove('bv-banner-on');
      return;
    }
    bannerEm.textContent = info.em;
    bannerNm.textContent = info.nm;
    banner.classList.remove('bv-show');
    void banner.offsetWidth;
    banner.classList.add('bv-show');
    root.classList.add('bv-banner-on');
  }

  // ---------- pop count-up ----------
  function animatePop(target) {
    const to = Math.max(0, Math.round(typeof target === 'number' && isFinite(target) ? target : 0));
    if (popDisplayed == null) {
      popDisplayed = to; popTarget = to; stPop.v.textContent = fmtNum(to);
      stPop.root.setAttribute('aria-label', to + (to === 1 ? ' person' : ' people'));
      return;
    }
    // Already animating toward (or settled at) this value — don't restart. This
    // guard uses popTarget, NOT popDisplayed: setStats is called ~every 0.2s but
    // the tween runs 0.45s, so guarding on popDisplayed (which only reaches `to`
    // at completion) would restart the tween forever and make the number flicker.
    if (to === popTarget) return;
    // real people change → announce politely for screen readers
    stPop.root.setAttribute('aria-label', to + (to === 1 ? ' person' : ' people'));
    announce('Now ' + to + (to === 1 ? ' person lives' : ' people live') + ' in your city');
    popTarget = to;
    const from = popDisplayed;

    stPop.root.classList.remove('bv-flash-up');
    void stPop.root.offsetWidth;
    stPop.root.classList.add('bv-flash-up');
    setTimeout(() => stPop.root.classList.remove('bv-flash-up'), 600);

    const myId = ++popAnimId;
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dur = 450;
    const raf = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : (cb) => setTimeout(() => cb(Date.now()), 16);
    function step(now) {
      if (myId !== popAnimId) return;
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const cur = Math.round(from + (to - from) * eased);
      popDisplayed = cur;                 // track the visible value every frame so a
      stPop.v.textContent = fmtNum(cur);  // new target mid-tween starts from here
      if (t < 1) raf(step);
      else { popDisplayed = to; stPop.v.textContent = fmtNum(to); }
    }
    raf(step);
  }

  // ---------- overlays ----------
  let activeOverlay = null;
  let activeOverlayDlg = null;
  function closeOverlay() {
    if (activeOverlayDlg) { try { activeOverlayDlg.dispose(); } catch (_) { /* ignore */ } activeOverlayDlg = null; }
    if (activeOverlay && activeOverlay.parentNode) activeOverlay.parentNode.removeChild(activeOverlay);
    activeOverlay = null;
  }

  function showNewConfirm() {
    closeOverlay();
    const ov = el('div', 'bv-overlay');
    const card = el('div', 'bv-card');
    card.appendChild(el('h2', null, 'Start a brand new city? 🏗️'));
    card.appendChild(el('p', null, 'Your city will go away!'));
    const choices = el('div', 'bv-choices');
    const keep = el('button', 'bv-cta bv-soft', 'Keep building!');
    keep.type = 'button';
    keep.addEventListener('click', closeOverlay);
    const go = el('button', 'bv-cta', 'New city!');
    go.type = 'button';
    go.addEventListener('click', () => { closeOverlay(); call(h.onNew); });
    choices.appendChild(keep); choices.appendChild(go);
    card.appendChild(choices);
    ov.appendChild(card);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeOverlay(); });
    root.appendChild(ov);
    activeOverlay = ov;
    activeOverlayDlg = makeDialog(ov, card, closeOverlay, { label: 'Start a new city', initialFocus: keep });
  }

  // ---------- confetti ----------
  function burstConfetti() {
    const layer = el('div', 'bv-confetti-layer');
    root.appendChild(layer);
    const W = layer.clientWidth || window.innerWidth || 800;
    const H = layer.clientHeight || window.innerHeight || 600;
    const parts = [];
    const count = 80;
    for (let i = 0; i < count; i++) {
      const useEmoji = Math.random() < 0.45;
      const p = el('div', 'bv-confetti' + (useEmoji ? '' : ' sq'));
      if (useEmoji) {
        p.textContent = CONFETTI_EMOJI[(Math.random() * CONFETTI_EMOJI.length) | 0];
        p.style.fontSize = (16 + Math.random() * 18) + 'px';
      } else {
        const s = 8 + Math.random() * 10;
        p.style.width = s + 'px'; p.style.height = s + 'px';
        p.style.background = CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0];
      }
      const x = W * (0.3 + Math.random() * 0.4);
      const y = H * 0.28;
      layer.appendChild(p);
      parts.push({
        el: p, x, y,
        vx: (Math.random() - 0.5) * 9,
        vy: -6 - Math.random() * 9,
        rot: Math.random() * 360,
        vrot: (Math.random() - 0.5) * 22,
      });
    }
    const raf = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : (cb) => setTimeout(() => cb(), 16);
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const grav = 0.32;
    function frame(now) {
      const t = (typeof now === 'number' ? now : Date.now());
      const elapsed = t - start;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.vy += grav;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;
        p.el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px) rotate(' + p.rot + 'deg)';
        if (elapsed > 2400) p.el.style.opacity = String(Math.max(0, 1 - (elapsed - 2400) / 600));
      }
      if (elapsed < 3000) raf(frame);
      else if (layer.parentNode) layer.parentNode.removeChild(layer);
    }
    raf(frame);
  }

  // ---------- toasts ----------
  function pushToast(text, emoji, variant) {
    const t = el('div', 'bv-toast' + (variant === 'blocked' ? ' bv-toast-blocked' : ''));
    if (variant === 'blocked') t.setAttribute('role', 'alert');
    if (emoji) { const e = el('span', 'bv-t-em', String(emoji)); e.setAttribute('aria-hidden', 'true'); t.appendChild(e); }
    t.appendChild(el('span', 'bv-t-tx', text == null ? '' : String(text)));
    toastLayer.appendChild(t);
    while (toastLayer.children.length > 3) {
      toastLayer.removeChild(toastLayer.firstChild);
    }
    const kill = () => {
      if (!t.parentNode) return;
      t.classList.add('bv-out');
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    };
    setTimeout(kill, 2500);
  }

  // ---------- sticker book ----------
  let stickerOv = null;      // overlay node
  let stickerHeadEl = null;  // header counter element
  let stickerBodyEl = null;  // scroll body element

  // Fill the header counter + section grids based on catalog + stickers.
  function renderStickerContents() {
    if (!stickerBodyEl) return;
    let total = 0, got = 0;
    stickerBodyEl.textContent = '';
    STICKER_SECTIONS.forEach((sec) => {
      const list = Array.isArray(catalog[sec.key]) ? catalog[sec.key] : [];
      if (!list.length) return;
      let secGot = 0;
      const secWrap = el('div', 'bv-sticker-sec');
      const title = el('div', 'bv-sticker-sec-title');
      title.appendChild(el('span', 'bv-ss-em', sec.emoji));
      title.appendChild(el('span', null, sec.label));
      const countEl = el('span', 'bv-ss-count', '');
      title.appendChild(countEl);
      secWrap.appendChild(title);
      const grid = el('div', 'bv-sticker-grid');
      list.forEach((entry) => {
        if (!entry || entry.id == null) return;
        total++;
        const has = stickers.has(entry.id);
        if (has) { got++; secGot++; }
        const cell = el('div', 'bv-cell ' + (has ? 'bv-got' : 'bv-locked'));
        cell.appendChild(el('span', 'bv-cell-em', entry.emoji || '🏢'));
        cell.appendChild(el('span', 'bv-cell-lbl', has ? (entry.name || String(entry.id)) : '???'));
        grid.appendChild(cell);
      });
      countEl.textContent = secGot + ' / ' + list.length;
      secWrap.appendChild(grid);
      stickerBodyEl.appendChild(secWrap);
    });
    if (stickerHeadEl) {
      stickerHeadEl.textContent = '📖 Sticker Book — ' + got + ' / ' + total + ' collected';
    }
  }

  let stickerDlg = null;
  function closeStickerBook() {
    stickerOpen = false;
    if (stickerDlg) { try { stickerDlg.dispose(); } catch (_) { /* ignore */ } stickerDlg = null; }
    if (stickerOv && stickerOv.parentNode) stickerOv.parentNode.removeChild(stickerOv);
    stickerOv = null; stickerHeadEl = null; stickerBodyEl = null;
  }

  function showStickerBook() {
    try {
      closeStickerBook();
      const ov = el('div', 'bv-overlay');
      const card = el('div', 'bv-card bv-sticker-card');
      stickerHeadEl = el('h2', 'bv-sticker-head', '📖 Sticker Book');
      card.appendChild(stickerHeadEl);
      stickerBodyEl = el('div', 'bv-sticker-scroll');
      card.appendChild(stickerBodyEl);
      const close = el('button', 'bv-cta', 'All done! ✕');
      close.type = 'button';
      close.addEventListener('click', closeStickerBook);
      card.appendChild(close);
      ov.appendChild(card);
      ov.addEventListener('click', (e) => { if (e.target === ov) closeStickerBook(); });
      root.appendChild(ov);
      stickerOv = ov;
      stickerOpen = true;
      renderStickerContents();
      stickerDlg = makeDialog(ov, card, closeStickerBook, { label: 'Sticker book', initialFocus: close });
    } catch (_) { /* ignore */ }
  }

  // ---------- postcard ----------
  let postcardOv = null;
  let postcardDlg = null;
  function closePostcard() {
    if (postcardDlg) { try { postcardDlg.dispose(); } catch (_) { /* ignore */ } postcardDlg = null; }
    if (postcardOv && postcardOv.parentNode) postcardOv.parentNode.removeChild(postcardOv);
    postcardOv = null;
  }
  function showPostcardOverlay(dataURL, cityName, day) {
    closePostcard();
    const name = (cityName == null || String(cityName).trim() === '') ? 'Blockville' : String(cityName).trim();
    const dnum = Math.max(1, Math.round(Number(day) || 1));
    const ov = el('div', 'bv-overlay bv-postcard-ov');

    const banner = el('div', 'bv-postcard-banner', '🏙️ ' + name + ' — Day ' + dnum);
    ov.appendChild(banner);

    const frame = el('div', 'bv-postcard-frame');
    const img = el('img');
    img.alt = name + ' postcard';
    if (dataURL != null) img.src = String(dataURL);
    frame.appendChild(img);
    ov.appendChild(frame);

    ov.appendChild(el('p', 'bv-postcard-hint', 'On iPad? Press and hold the picture to save it!'));

    const btns = el('div', 'bv-postcard-btns');
    const save = el('a', 'bv-save-btn');
    save.textContent = '💾 Save picture';
    save.setAttribute('download', 'blockville-postcard.png');
    if (dataURL != null) save.href = String(dataURL);
    btns.appendChild(save);
    const close = el('button', 'bv-close-btn', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close';
    close.addEventListener('click', closePostcard);
    btns.appendChild(close);
    ov.appendChild(btns);

    ov.addEventListener('click', (e) => { if (e.target === ov) closePostcard(); });
    root.appendChild(ov);
    postcardOv = ov;
    postcardDlg = makeDialog(ov, ov, closePostcard, { label: 'Your city postcard', initialFocus: close });
  }

  // ---------- city name dialog ----------
  let nameOv = null;
  let nameDlg = null;
  function closeNameDialog() {
    if (nameDlg) { try { nameDlg.dispose(); } catch (_) { /* ignore */ } nameDlg = null; }
    if (nameOv && nameOv.parentNode) nameOv.parentNode.removeChild(nameOv);
    nameOv = null;
  }
  function showNameDialog(current, onDone) {
    closeNameDialog();
    const done = (raw) => {
      closeNameDialog();
      const trimmed = (raw == null ? '' : String(raw)).trim();
      call(onDone, trimmed || 'Blockville');
    };
    const ov = el('div', 'bv-overlay');
    const card = el('div', 'bv-card');
    card.appendChild(el('h2', null, "What's your city called?"));
    const input = el('input', 'bv-name-input');
    input.type = 'text';
    input.maxLength = 20;
    input.value = (current == null ? '' : String(current)).slice(0, 20);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'words');
    input.addEventListener('focus', () => { try { input.select(); } catch (_) { /* ignore */ } });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
    });
    card.appendChild(input);
    const cta = el('button', 'bv-cta', "That's it! ✨");
    cta.type = 'button';
    cta.addEventListener('click', () => done(input.value));
    card.appendChild(cta);
    ov.appendChild(card);
    ov.addEventListener('click', (e) => { if (e.target === ov) done(input.value); });
    root.appendChild(ov);
    nameOv = ov;
    nameDlg = makeDialog(ov, card, () => done(input.value), { label: 'Name your city', initialFocus: input });
    setTimeout(() => { try { input.select(); } catch (_) { /* ignore */ } }, 60);
  }

  // ---------- first-run mode picker ----------
  let modeOv = null, modeDlg = null;
  function closeModePicker() {
    if (modeDlg) { try { modeDlg.dispose(); } catch (_) { /* ignore */ } modeDlg = null; }
    if (modeOv && modeOv.parentNode) modeOv.parentNode.removeChild(modeOv);
    modeOv = null;
  }
  function showModePickerOverlay(onPick) {
    closeModePicker();
    const pick = (mode) => {
      closeModePicker();
      const cb = (typeof onPick === 'function') ? onPick : h.onMode;
      call(cb, mode);
    };
    const ov = el('div', 'bv-overlay bv-menu-overlay');
    if (ART && ART['menu-bg']) ov.style.backgroundImage =
      'linear-gradient(rgba(135,212,245,.35), rgba(135,212,245,.65)), url(' + ART['menu-bg'] + ')';
    const card = el('div', 'bv-card bv-mode-card');
    if (ART && ART['logo-blockville']) {
      const logo = el('div', 'bv-menu-logo');
      const img = document.createElement('img'); img.src = ART['logo-blockville'];
      img.alt = 'Blockville'; img.draggable = false; logo.appendChild(img);
      card.appendChild(logo);
    } else {
      card.appendChild(el('h1', 'bv-menu-title', '🏗️ Blockville'));
    }
    card.appendChild(el('h2', null, 'How do you want to play? 🎮'));
    card.appendChild(el('p', null, 'Pick a way to build — you can change it later!'));
    const grid = el('div', 'bv-mode-grid');
    let firstOpt = null;
    [
      ['picture', '🧸', 'Picture Play', 'Ages 5–6', 'mode-picture-play'],
      ['explorer', '🏙️', 'City Explorer', 'Ages 7–9', 'mode-city-explorer'],
      ['everything', '✨', 'Everything', 'All the tools', 'mode-everything'],
    ].forEach(([mode, em, nm, age, art]) => {
      const opt = el('button', 'bv-mode-opt');
      opt.type = 'button';
      opt.setAttribute('aria-label', nm + ', ' + age);
      const emS = el('span', 'bv-mode-em'); setGlyph(emS, art, em); emS.setAttribute('aria-hidden', 'true');
      opt.appendChild(emS);
      opt.appendChild(el('span', 'bv-mode-nm', nm));
      opt.appendChild(el('span', 'bv-mode-age', age));
      opt.addEventListener('click', () => pick(mode));
      grid.appendChild(opt);
      if (!firstOpt) firstOpt = opt;
    });
    card.appendChild(grid);
    ov.appendChild(card);
    root.appendChild(ov);
    modeOv = ov;
    modeDlg = makeDialog(ov, card, closeModePicker, { label: 'Choose how to play', initialFocus: firstOpt });
  }

  // ---------- picture-play bottom bar ----------
  function buildPicBar(palette) {
    picbar.textContent = '';
    Object.keys(picBtns).forEach((k) => { delete picBtns[k]; });
    const items = Array.isArray(palette) ? palette : [];
    items.forEach((item) => {
      if (!item || item.id == null) return;
      const b = el('button', 'bv-pic-btn');
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', item.label || String(item.id));
      const em = el('span', 'bv-pic-em', item.emoji || '🧱'); em.setAttribute('aria-hidden', 'true');
      b.appendChild(em);
      b.appendChild(el('span', 'bv-pic-lbl', item.label || String(item.id)));
      b.addEventListener('click', () => onPicClick(item));
      picbar.appendChild(b);
      picBtns[item.id] = { btn: b, item };
    });
    updatePicVisuals();
  }
  function onPicClick(item) {
    const label = item.label || String(item.id);
    const toolVal = (item.kind === 'entry') ? (item.entry || { id: item.id }) : String(item.id);
    const already = (item.kind === 'entry')
      ? (activeEntryId() != null && String(activeEntryId()) === String(item.id))
      : (activeDirectId() === String(item.id));
    applyActive(already ? null : toolVal);
    call(h.onPalettePick, item);
    if (speechOn) call(h.onSpeak, label);
  }

  // ---------- mode switching ----------
  let curMode = 'everything';
  const advButtons = [undoBtn, photoBtn, bookBtn, citiesBtn];
  function applyMode(mode, picturePalette) {
    const m = (mode === 'picture' || mode === 'explorer' || mode === 'everything') ? mode : 'everything';
    curMode = m;
    root.classList.toggle('bv-mode-picture', m === 'picture');
    // hide advanced top-bar buttons in Picture Play (minimal UI)
    advButtons.forEach((b) => { if (b) b.style.display = (m === 'picture') ? 'none' : ''; });
    if (m === 'picture') {
      buildPicBar(picturePalette);
      picbar.classList.add('bv-show');
      if (openCat != null) closeDrawer(false);
      // Picture Play turns read-aloud on by default — reflect it in the toggle
      speechOn = true;
      setPressed(speechBtn, true);
      speechBtn.setAttribute('aria-label', 'Read aloud on');
    } else {
      picbar.classList.remove('bv-show');
    }
  }

  // ---------- favorites row ----------
  function setFavoritesRow(entries) {
    favsStrip.textContent = '';
    const list = Array.isArray(entries) ? entries.filter((e) => e && e.id != null) : [];
    if (!list.length) {
      favs.classList.remove('bv-show');
      root.classList.remove('bv-fav-on');
      return;
    }
    list.forEach((entry) => {
      const b = el('button', 'bv-fav-btn');
      b.type = 'button';
      b.setAttribute('aria-label', 'Place ' + (entry.name || String(entry.id)));
      const em = el('span', 'bv-fav-em', entry.emoji || '🏢'); em.setAttribute('aria-hidden', 'true');
      b.appendChild(em);
      b.appendChild(el('span', 'bv-fav-lbl', entry.name || String(entry.id)));
      b.addEventListener('click', () => {
        applyActive(entry);
        call(h.onTool, entry);
        call(h.onFavorite, entry);
      });
      favsStrip.appendChild(b);
    });
    favs.classList.add('bv-show');
    if (curMode !== 'picture') root.classList.add('bv-fav-on');
  }

  // ---------- city helper (mission) ----------
  function setMissionData(m) {
    const d = m || {};
    misEm.textContent = d.emoji || '🎯';
    misTitle.textContent = d.title == null ? '' : String(d.title);
    missionSay = d.say == null ? '' : String(d.say);
    const total = Math.max(0, Math.round(Number(d.total) || 0));
    const doneRaw = Math.max(0, Math.round(Number(d.done) || 0));
    const done = total > 0 ? Math.min(total, doneRaw) : doneRaw;
    const complete = !!d.complete;
    misProg.textContent = total > 0 ? (done + ' of ' + total) : '';
    const pct = complete ? 100 : (total > 0 ? Math.round(Math.min(1, done / total) * 100) : 0);
    misFill.style.width = pct + '%';
    misAsk.textContent = d.ask == null ? '' : String(d.ask);
    mission.classList.toggle('bv-complete', complete);
    mission.classList.add('bv-show');
    mission.setAttribute('aria-label', 'City Helper: ' + (d.title || 'Mission'));
  }
  function hideMissionCard() { mission.classList.remove('bv-show'); }

  // ---------- city manager ----------
  let cityOv = null, cityDlg = null, cityArgs = null;
  function closeCityManager() {
    if (cityDlg) { try { cityDlg.dispose(); } catch (_) { /* ignore */ } cityDlg = null; }
    if (cityOv && cityOv.parentNode) cityOv.parentNode.removeChild(cityOv);
    cityOv = null; cityArgs = null;
  }
  function renderCityRows(listWrap) {
    listWrap.textContent = '';
    const cities = Array.isArray(cityArgs.cities) ? cityArgs.cities : [];
    const currentId = cityArgs.currentId;
    if (!cities.length) {
      listWrap.appendChild(el('div', 'bv-drawer-empty', 'No cities yet — make one!'));
      return;
    }
    cities.forEach((c) => {
      if (!c || c.id == null) return;
      const isCurrent = String(c.id) === String(currentId);
      const row = el('div', 'bv-city-row' + (isCurrent ? ' bv-current' : ''));
      const info = el('div', 'bv-city-info');
      info.appendChild(el('div', 'bv-city-name', c.name || 'City'));
      const day = Math.max(1, Math.round(Number(c.day) || 1));
      const pop = Math.max(0, Math.round(Number(c.pop) || 0));
      info.appendChild(el('div', 'bv-city-sub', 'Day ' + day + ' · 👥 ' + pop));
      row.appendChild(info);
      const acts = el('div', 'bv-city-acts');
      if (isCurrent) {
        acts.appendChild(el('span', 'bv-city-current-tag', 'Playing'));
      } else {
        const load = iconBtn('bv-city-act', '▶️', 'Play ' + (c.name || 'city'), 'Play');
        load.addEventListener('click', () => {
          const cb = cityArgs.onLoad || h.onCityLoad;
          call(cb, c.id);
          closeCityManager();
        });
        acts.appendChild(load);
      }
      const ren = iconBtn('bv-city-act', '✏️', 'Rename ' + (c.name || 'city'), 'Rename');
      ren.addEventListener('click', () => {
        showNameDialog(c.name || '', (name) => {
          const cb = cityArgs.onRename || h.onCityRename;
          call(cb, c.id, name);
          c.name = name;
          renderCityRows(listWrap);
        });
      });
      acts.appendChild(ren);
      const del = iconBtn('bv-city-act', '🗑️', 'Delete ' + (c.name || 'city'), 'Delete');
      del.addEventListener('click', () => {
        const cb = cityArgs.onDelete || h.onCityDelete;
        call(cb, c.id);
        cityArgs.cities = (cityArgs.cities || []).filter((x) => String(x.id) !== String(c.id));
        renderCityRows(listWrap);
      });
      acts.appendChild(del);
      row.appendChild(acts);
      listWrap.appendChild(row);
    });
  }
  function showCityManagerOverlay(opts) {
    closeCityManager();
    cityArgs = opts || {};
    const ov = el('div', 'bv-overlay');
    const card = el('div', 'bv-card bv-cities-card');
    card.appendChild(el('h2', null, 'My Cities 🗂️'));
    const listWrap = el('div', 'bv-cities-list');
    card.appendChild(listWrap);
    const newC = el('button', 'bv-cta', '➕ New City');
    newC.type = 'button';
    newC.addEventListener('click', () => {
      showNameDialog('', (name) => {
        const cb = cityArgs && (cityArgs.onNew || h.onCityNew);
        call(cb, name);
        closeCityManager();
      });
    });
    card.appendChild(newC);
    ov.appendChild(card);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeCityManager(); });
    root.appendChild(ov);
    cityOv = ov;
    renderCityRows(listWrap);
    cityDlg = makeDialog(ov, card, closeCityManager, { label: 'My cities' });
  }

  // ===================== PUBLIC API =====================
  const api = {
    setStats(s) {
      try {
        const d = s || {};
        if ('pop' in d) animatePop(d.pop);
        if ('jobs' in d) {
          const j = Math.max(0, Math.round(Number(d.jobs) || 0));
          stJobs.v.textContent = fmtNum(j);
          stJobs.root.style.display = '';
          stJobs.root.setAttribute('aria-label', j + (j === 1 ? ' job' : ' jobs'));
        }
        if ('happiness' in d) {
          const f = happyFace(d.happiness);
          setGlyph(happyIc, f.art, f.em);
          happyIc.setAttribute('aria-label', 'Happiness: ' + f.word);
          stHappy.setAttribute('aria-label', 'People are ' + f.word);
          stHappy.style.display = '';
        }
        if ('air' in d) {
          const a = clamp01(d.air);
          airFill.style.width = Math.round(a * 100) + '%';
          const airWord = a < 0.4 ? 'smoggy' : (a < 0.7 ? 'okay' : 'clean');
          stAir.setAttribute('aria-label', 'Air is ' + airWord);
          stAir.style.display = '';
        }
        if ('day' in d) {
          const day = Math.max(1, Math.round(Number(d.day) || 1));
          dayVal.textContent = 'Day ' + day;
        }
        if ('clockLabel' in d) {
          daySub.textContent = d.clockLabel == null ? '' : String(d.clockLabel);
          const em = dayIcon(d.clockLabel);
          setGlyph(dayIc, em === '🌙' ? 'stat-night' : 'stat-day', em);
        }
      } catch (_) { /* never throw at callers */ }
    },

    setCatalog(cat) {
      try {
        // reset stored catalog + card registry
        Object.keys(catalog).forEach((k) => { delete catalog[k]; });
        Object.keys(cardBtns).forEach((k) => { delete cardBtns[k]; });
        const src = cat || {};
        CATEGORY_TABS.forEach((t) => {
          const list = Array.isArray(src[t.key]) ? src[t.key] : [];
          catalog[t.key] = list.slice();
        });
        // rebuild the open drawer (if any) so cards reflect the new catalog
        if (openCat != null) buildDrawerCards(openCat);
      } catch (_) { /* ignore */ }
    },

    setActiveTool(tool) {
      try {
        if (tool == null) { applyActive(null); return; }
        // catalog entry object -> match by id
        if (typeof tool === 'object') {
          const id = tool.id;
          if (id == null) { applyActive(null); return; }
          // prefer our registered entry (so visuals + hooks stay consistent)
          const known = cardBtns[id] ? cardBtns[id].entry : tool;
          applyActive(known);
          return;
        }
        // direct tool string
        if (tool === 'road' || tool === 'tree' || tool === 'bulldoze') {
          applyActive(tool);
          return;
        }
        // an id that matches a catalog entry passed as a string
        if (cardBtns[tool]) { applyActive(cardBtns[tool].entry); return; }
        applyActive(null);
      } catch (_) { /* ignore */ }
    },

    setStickers(placedSet) {
      try {
        // defensive copy into our own Set of type ids
        const next = new Set();
        if (placedSet) {
          if (typeof placedSet.forEach === 'function') {
            placedSet.forEach((id) => { if (id != null) next.add(id); });
          } else if (Array.isArray(placedSet)) {
            placedSet.forEach((id) => { if (id != null) next.add(id); });
          }
        }
        // announce freshly collected stickers (skip the very first bulk load)
        if (stickers && stickers.size) {
          const added = [];
          next.forEach((id) => { if (!stickers.has(id)) added.push(id); });
          if (added.length === 1) announce('New sticker: ' + entryName(added[0]) + '!');
          else if (added.length > 1) announce('You collected ' + added.length + ' new stickers!');
        }
        stickers = next;
        // live update if the book is open
        if (stickerOpen) renderStickerContents();
      } catch (_) { /* ignore */ }
    },

    showStickerBook() {
      try { showStickerBook(); } catch (_) { /* ignore */ }
    },

    showPostcard(dataURL, cityName, day) {
      try { showPostcardOverlay(dataURL, cityName, day); } catch (_) { /* ignore */ }
    },

    askCityName(current, onDone) {
      try { showNameDialog(current, onDone); }
      catch (_) { try { if (typeof onDone === 'function') onDone('Blockville'); } catch (__) { /* ignore */ } }
    },

    toast(text, emoji) {
      try { pushToast(text, emoji); } catch (_) { /* ignore */ }
    },

    celebrate(title, subtitle) {
      try {
        burstConfetti();
        root.querySelectorAll('.bv-celebrate').forEach((b) => b.remove());
        const banner = el('div', 'bv-celebrate');
        banner.appendChild(el('div', 'bv-cele-title', title == null ? '🎉 Hooray!' : String(title)));
        if (subtitle != null && String(subtitle).length) {
          banner.appendChild(el('div', 'bv-cele-sub', String(subtitle)));
        }
        root.appendChild(banner);
        setTimeout(() => {
          banner.classList.add('bv-out');
          setTimeout(() => { if (banner.parentNode) banner.parentNode.removeChild(banner); }, 420);
        }, 3500);
      } catch (_) { /* ignore */ }
    },

    showWelcome() {
      try {
        closeOverlay();
        const ov = el('div', 'bv-overlay');
        const card = el('div', 'bv-card');
        card.appendChild(el('h2', null, 'Welcome to Blockville! 🏙️'));
        card.appendChild(el('p', null, "Let's build an awesome city together!"));
        const steps = el('div', 'bv-steps');
        [
          ['🛣️', '1. Draw roads', 'step-1-roads'],
          ['🏠', '2. Pick buildings and place them!', 'step-2-build'],
          ['👀', '3. Watch your city come alive!', 'step-3-alive'],
        ].forEach(([emo, tx, art]) => {
          const st = el('div', 'bv-step');
          const emS = el('span', 'bv-step-em'); setGlyph(emS, art, emo);
          st.appendChild(emS);
          st.appendChild(el('span', 'bv-step-tx', tx));
          steps.appendChild(st);
        });
        card.appendChild(steps);
        card.appendChild(el('p', 'bv-hint', '✋ Drag to move around · 🤏 Pinch to zoom'));
        const cta = el('button', 'bv-cta', "Let's build! 🚀");
        cta.type = 'button';
        // Just close — this button dismisses the tutorial. (The ❓ Help button is
        // what RE-opens it via onHelp; wiring onHelp here caused an open/close loop.)
        cta.addEventListener('click', () => { closeOverlay(); });
        card.appendChild(cta);
        ov.appendChild(card);
        ov.addEventListener('click', (e) => { if (e.target === ov) closeOverlay(); });
        root.appendChild(ov);
        activeOverlay = ov;
        activeOverlayDlg = makeDialog(ov, card, closeOverlay, { label: 'Welcome to Blockville', initialFocus: cta });
      } catch (_) { /* ignore */ }
    },

    // ---- v3.3 additions ----
    showModePicker(onPick) {
      try { showModePickerOverlay(onPick); } catch (_) { /* ignore */ }
    },

    setMode(mode, picturePalette) {
      try { applyMode(mode, picturePalette); } catch (_) { /* ignore */ }
    },

    showBlocked(text) {
      try { pushToast(text == null ? 'Try another spot!' : String(text), '🚫', 'blocked'); } catch (_) { /* ignore */ }
    },

    setFavorites(entries) {
      try { setFavoritesRow(entries); } catch (_) { /* ignore */ }
    },

    setMission(m) {
      try { setMissionData(m); } catch (_) { /* ignore */ }
    },

    hideMission() {
      try { hideMissionCard(); } catch (_) { /* ignore */ }
    },

    showCityManager(opts) {
      try { showCityManagerOverlay(opts); } catch (_) { /* ignore */ }
    },

    announce(text) {
      try { announce(text); } catch (_) { /* ignore */ }
    },

    destroy() {
      try { if (root.parentNode) root.parentNode.removeChild(root); } catch (_) { /* ignore */ }
    },
  };

  return api;
}
