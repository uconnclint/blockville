// Blockville (sandbox) — integration layer. Owns boot, game loop, input routing,
// and wiring between sim / engine / models / life / ui / audio / challenges
// (which never import each other directly).

import { TILE, N, T, idx, inBounds } from './constants.js';
import * as models from './models.js';
import { Engine } from './engine.js';
import { Sim } from './sim.js';
import { Life } from './life.js';
import { initUI } from './ui.js';
import * as audio from './audio.js';
import { CHALLENGES, GUIDED, makeBaseline, progress } from './challenges.js';
import { Net, makeCode, normalizeCode } from './net.js';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game');
const engine = new Engine(canvas);
engine.setPalette(models.PALETTE);
engine.attachInput(canvas);

const sim = new Sim();
sim.setCatalog(models.CATALOG);

// Catalog lookup by id (saves, debug, ghosts, picture palette)
const ENTRY_BY_ID = {};
for (const list of Object.values(models.CATALOG)) {
  for (const entry of list) ENTRY_BY_ID[entry.id] = entry;
}
const challengeById = {};
for (const c of CHALLENGES) challengeById[c.id] = c;

const hash2 = (x, z) => ((x * 73856093) ^ (z * 19349663)) >>> 0;

// ---------------------------------------------------------------------------
// Named cities (save slots) — replaces the old single autosave
// ---------------------------------------------------------------------------
const CITIES_KEY = 'bv-cities';       // [{id,name,day,pop}]
const CURRENT_KEY = 'bv-current';     // id string
const MODE_KEY = 'bv-mode';           // 'picture'|'explorer'|'everything'
const SPEECH_KEY = 'bv-speech';       // '1'|'0'
const BRIGHT_KEY = 'bv-bright';       // '1'|'0'
const STICKER_KEY = 'blockville-stickers';
const LEGACY_SAVE = 'blockville-save';
const LEGACY_NAME = 'blockville-cityname';
const cityKey = (id) => 'bv-city-' + id;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
function newCityId() { return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36); }

let cities = [];
try { const a = JSON.parse(lsGet(CITIES_KEY) || '[]'); if (Array.isArray(a)) cities = a.filter((c) => c && c.id); } catch (e) {}
let currentId = lsGet(CURRENT_KEY);

// First run / migration from the old single-save format.
if (cities.length === 0) {
  const id = newCityId();
  const name = (lsGet(LEGACY_NAME) || 'Blockville').slice(0, 20);
  cities = [{ id, name }];
  const legacy = lsGet(LEGACY_SAVE);
  if (legacy) lsSet(cityKey(id), legacy);
  lsSet(CITIES_KEY, JSON.stringify(cities));
  currentId = id; lsSet(CURRENT_KEY, id);
}
if (!currentId || !cities.some((c) => c.id === currentId)) { currentId = cities[0].id; lsSet(CURRENT_KEY, currentId); }

let loadedFromSave = false;
{ const raw = lsGet(cityKey(currentId)); if (raw && sim.load(raw)) loadedFromSave = true; }

const currentCity = () => cities.find((c) => c.id === currentId) || cities[0];
const cityName = () => (currentCity() && currentCity().name) || 'Blockville';
function saveIndex() { lsSet(CITIES_KEY, JSON.stringify(cities)); }
function autosave() {
  lsSet(cityKey(currentId), sim.save());
  const c = currentCity();
  if (c) { c.day = sim.state.day; c.pop = sim.state.pop; saveIndex(); }
}

const life = new Life(engine, models);

// ---------------------------------------------------------------------------
// Visuals from sim state
// ---------------------------------------------------------------------------
function roadMask(x, z) {
  const m = sim.state.map;
  let mask = 0;
  if (inBounds(x, z - 1) && m[idx(x, z - 1)] === T.ROAD) mask |= 1;
  if (inBounds(x + 1, z) && m[idx(x + 1, z)] === T.ROAD) mask |= 2;
  if (inBounds(x, z + 1) && m[idx(x, z + 1)] === T.ROAD) mask |= 4;
  if (inBounds(x - 1, z) && m[idx(x - 1, z)] === T.ROAD) mask |= 8;
  return mask;
}
function refreshRoadProp(x, z) {
  engine.removeProp('road', x, z);
  if (inBounds(x, z) && sim.state.map[idx(x, z)] === T.ROAD) {
    const i = idx(x, z);
    const overWater = sim.state.bridge && sim.state.bridge[i] === 1 && typeof models.bridgeModel === 'function';
    const model = overWater ? models.bridgeModel(roadMask(x, z)) : models.roadModel(roadMask(x, z));
    engine.addProp('road', model, x, z);
  }
}
function refreshRoadArea(x, z) {
  refreshRoadProp(x, z);
  refreshRoadProp(x, z - 1); refreshRoadProp(x + 1, z);
  refreshRoadProp(x, z + 1); refreshRoadProp(x - 1, z);
}
const buildingModelFor = (b) => models.catalogModel(b.type || b.id, b.variant || 0);

// --- animated building parts (ferris wheel, carousel, turbine…) -------------
const spinners = new Map();
function addSpinner(bid, type, x, z, rot, etw, etd) {
  if (typeof models.catalogAnim !== 'function' || typeof engine.makeSpinner !== 'function') return;
  const anim = models.catalogAnim(type);
  if (!anim || !anim.part) return;
  const handle = engine.makeSpinner(anim.part);
  const yaw = (rot || 0) * Math.PI / 2;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const ox = (anim.ox || 0) * c + (anim.oz || 0) * s;
  const oz = -(anim.ox || 0) * s + (anim.oz || 0) * c;
  handle.setPos((x + (etw || 1) / 2) * TILE + ox, anim.oy || 0, (z + (etd || 1) / 2) * TILE + oz);
  handle.setBaseYaw(yaw);
  spinners.set(bid, { handle, ax: anim.ax || 0, ay: anim.ay || 1, az: anim.az || 0, speed: anim.speed || 0.5, angle: Math.random() * Math.PI * 2 });
}
function removeSpinner(bid) { const sp = spinners.get(bid); if (sp) { try { sp.handle.dispose(); } catch (e) {} spinners.delete(bid); } }
function clearSpinners() { for (const bid of [...spinners.keys()]) removeSpinner(bid); }

function rebuildAllVisuals() {
  if (typeof engine.clearWorld === 'function') engine.clearWorld();
  clearSpinners();
  engine.buildGround(sim.state);
  const m = sim.state.map;
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const t = m[idx(x, z)];
    if (t === T.ROAD) refreshRoadProp(x, z);
    else if (t === T.TREE) engine.addProp('tree', models.treeModel(hash2(x, z) % 8), x, z);
  }
  for (const b of sim.state.buildings) {
    const model = buildingModelFor(b);
    if (model) engine.addBuilding(b.bid, model, b.x, b.z, 1, b.rot || 0);
    addSpinner(b.bid, b.type, b.x, b.z, b.rot || 0, b.tw, b.td);
  }
  life.sync(sim.state, sim.roadGraph());
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------
const undoStack = [];
function pushUndo() {
  try { const snap = sim.save(); if (undoStack[undoStack.length - 1] === snap) return; undoStack.push(snap); if (undoStack.length > 25) undoStack.shift(); } catch (e) {}
}
function doUndo() {
  // Undo replays a whole snapshot, which would desync a shared room — off online.
  if (onlineFlag) { ui.toast('Undo is off when building with friends.', '🤝'); return; }
  while (undoStack.length && undoStack[undoStack.length - 1] === sim.save()) undoStack.pop();
  const snap = undoStack.pop();
  if (!snap) { ui.toast('Nothing to undo!', '🤷'); return; }
  if (sim.load(snap)) { growAnims.clear(); rebuildAllVisuals(); audio.play('bulldoze'); ui.toast('Undone!', '↩️'); }
}

// ---------------------------------------------------------------------------
// Stickers (persist across all cities)
// ---------------------------------------------------------------------------
const stickers = new Set();
try { for (const id of JSON.parse(lsGet(STICKER_KEY) || '[]')) stickers.add(id); } catch (e) {}
function recordSticker(typeId, name) {
  if (!typeId || stickers.has(typeId)) return;
  stickers.add(typeId);
  lsSet(STICKER_KEY, JSON.stringify([...stickers]));
  if (ui.setStickers) ui.setStickers(stickers);
  ui.toast(`New sticker: ${name || typeId}!`, '📖');
}

// ---------------------------------------------------------------------------
// Speech (read-aloud)
// ---------------------------------------------------------------------------
const speak = (text) => { try { audio.speak(text); } catch (e) {} };
const speechOn = () => { try { return audio.isSpeechEnabled && audio.isSpeechEnabled(); } catch (e) { return false; } };
function setSpeech(on) { try { audio.setSpeechEnabled(on); } catch (e) {} lsSet(SPEECH_KEY, on ? '1' : '0'); }

// ---------------------------------------------------------------------------
// City Helper — guided missions from challenges.js
// ---------------------------------------------------------------------------
let helperOn = false, guidedIdx = 0, mission = null, baseline = null, customMission = false;
let placedSinceStart = 0, missionComplete = false;
let cityNamedFlag = false, postcardFlag = false;

function missionMetrics() {
  const m = (sim.metrics && sim.metrics()) || {};
  m.cityNamed = cityNamedFlag; m.postcardTaken = postcardFlag; m.placedSinceStart = placedSinceStart;
  return m;
}
function pushMission(complete) {
  if (!mission || !ui.setMission) return;
  const p = progress(mission.goal, missionMetrics(), baseline);
  ui.setMission({ emoji: mission.emoji, title: mission.title, say: mission.say, done: p.done, total: p.total, ask: mission.ask, complete: !!complete });
}
function startMission(id) {
  mission = challengeById[id];
  if (!mission) { helperOn = false; if (ui.hideMission) ui.hideMission(); return; }
  baseline = makeBaseline(mission.goal, (sim.metrics && sim.metrics()) || {});
  placedSinceStart = 0; missionComplete = false;
  pushMission(false);
  if (id === 'bridge') focusNearestRiver();
  if (speechOn()) speak(mission.say);
}
function startHelper() { helperOn = true; customMission = false; guidedIdx = 0; startMission(GUIDED[0]); }
function startProject(id) { helperOn = true; customMission = true; startMission(id); }
function checkMission() {
  if (!helperOn || !mission || missionComplete) return;
  const p = progress(mission.goal, missionMetrics(), baseline);
  if (ui.setMission) ui.setMission({ emoji: mission.emoji, title: mission.title, say: mission.say, done: p.done, total: p.total, ask: mission.ask, complete: p.complete });
  if (p.complete) {
    missionComplete = true;
    audio.play('upgrade');
    if (speechOn()) speak('Great job! ' + (mission.ask || ''));
  }
}
function nextMission() {
  if (customMission) {
    customMission = false; helperOn = false; mission = null;
    if (ui.hideMission) ui.hideMission();
    ui.celebrate('Project complete! 🎉', 'Pick another project any time from Help.');
    return;
  }
  guidedIdx++;
  if (guidedIdx < GUIDED.length) startMission(GUIDED[guidedIdx]);
  else { helperOn = false; if (ui.hideMission) ui.hideMission(); ui.celebrate('You did it! 🎉', 'You finished all the helper missions!'); audio.play('milestone'); }
}
function freeBuild() { helperOn = false; mission = null; if (ui.hideMission) ui.hideMission(); }

// ---------------------------------------------------------------------------
// Gentle cause-and-effect suggestions
// ---------------------------------------------------------------------------
let suggestTimer = 0, lastSuggest = '';
function maybeSuggest(dt) {
  suggestTimer += dt;
  if (suggestTimer < 25) return;
  if (helperOn && mission && !missionComplete) { suggestTimer = 0; return; } // don't clutter a mission
  const m = (sim.metrics && sim.metrics()) || {};
  const opts = [];
  if (m.factories > 0 && m.air < 0.72) opts.push(['So much smoke! Plant trees to clean the air.', '🌳']);
  if (m.homes >= 3 && m.parks === 0) opts.push(['Add a park — it makes your neighborhood happier!', '🎠']);
  if (m.homes === 0 && (m.shops + m.downtown + m.factories) > 0) opts.push(['Add some homes so people can move in!', '🏠']);
  if (m.homes >= 5 && m.shops === 0) opts.push(['Your people need shops to visit!', '🏪']);
  if (m.residents > 0 && m.jobs === 0) opts.push(['Add a shop or factory so grown-ups have places to work!', '💼']);
  if (m.jobs > Math.max(8, m.residents * 2)) opts.push(['There are lots of jobs—build more homes for new neighbors!', '🏠']);
  if ((m.homes + m.shops + m.factories + m.funCount) > 0 && m.roadConnectedBuildings === 0) {
    opts.push(['Put a road beside a building—then cars and walkers can visit!', '🛣️']);
  }
  suggestTimer = 0;
  if (!opts.length) return;
  const pick = opts.find((o) => o[0] !== lastSuggest) || opts[0];
  lastSuggest = pick[0];
  ui.toast(pick[0], pick[1]);
}

// ---------------------------------------------------------------------------
// Photo postcard
// ---------------------------------------------------------------------------
function takePhoto() {
  const shoot = (name) => {
    try {
      engine.render(0.016);
      const url = canvas.toDataURL('image/png');
      if (ui.showPostcard) ui.showPostcard(url, name, sim.state.day);
      postcardFlag = true;
      audio.play('place');
    } catch (e) { ui.toast('Photo failed — try again!', '📷'); }
  };
  const name = cityName();
  if (name && name !== 'Blockville') { shoot(name); return; }
  if (ui.askCityName) ui.askCityName(name || 'Blockville', (picked) => { renameCurrentCity(picked); shoot(cityName()); });
  else shoot('Blockville');
}
function renameCurrentCity(name) {
  const c = currentCity();
  if (c) { c.name = (name || 'Blockville').slice(0, 20); saveIndex(); cityNamedFlag = true; }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
let mode = lsGet(MODE_KEY);
function picturePalette() {
  const items = [
    { kind: 'tool', id: 'move', emoji: '✋', label: 'Move' },
    { kind: 'tool', id: 'road', emoji: '🛣️', label: 'Road' },
  ];
  const wanted = ['small-house', 'bakery', 'park', 'school', 'toy-factory'];
  for (const id of wanted) {
    let e = ENTRY_BY_ID[id];
    if (!e && id === 'bakery') { const shop = models.CATALOG.shops && models.CATALOG.shops[0]; e = shop; }
    if (e) items.push({ kind: 'entry', id: e.id, emoji: e.emoji, label: e.name, entry: e });
  }
  items.push({ kind: 'tool', id: 'tree', emoji: '🌳', label: 'Tree' });
  items.push({ kind: 'tool', id: 'bulldoze', emoji: '🧹', label: 'Erase' });
  return items;
}
function applyMode(m) {
  mode = m; lsSet(MODE_KEY, m);
  if (ui.setMode) ui.setMode(m, m === 'picture' ? picturePalette() : null);
  activeTool = null;
  if (ui.setActiveTool) ui.setActiveTool('move');
  const def = m === 'picture'; // narration on by default only in Picture Play
  const pref = lsGet(SPEECH_KEY);
  const speech = pref === null ? def : pref === '1';
  setSpeech(speech);
  if (ui.setSpeechState) ui.setSpeechState(speech);
}

function focusCity() {
  if (!engine.focusAt) return;
  const pts = [];
  for (const b of sim.state.buildings) pts.push([b.x + (b.tw || 1) / 2, b.z + (b.td || 1) / 2]);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const t = sim.state.map[idx(x, z)];
    if (t === T.ROAD) pts.push([x, z]);
  }
  if (!pts.length) { engine.focusAt(N / 2, N / 2, 175); ui.toast('Here is your building area!', '🎯'); return; }
  let sx = 0, sz = 0; for (const p of pts) { sx += p[0]; sz += p[1]; }
  engine.focusAt(sx / pts.length, sz / pts.length, Math.min(230, Math.max(90, 90 + Math.sqrt(pts.length) * 7)));
  ui.toast('Found your city!', '🎯');
}

function focusNearestRiver() {
  if (!engine.focusAt) return;
  let best = null, bestD = Infinity;
  for (let z = 1; z < N - 1; z++) for (let x = 1; x < N - 1; x++) {
    if (sim.state.map[idx(x, z)] !== T.WATER) continue;
    const d = (x - N / 2) ** 2 + (z - N / 2) ** 2;
    if (d < bestD) { bestD = d; best = { x, z }; }
  }
  if (best) { engine.focusAt(best.x, best.z, 125); ui.toast('The blue water is ready for your bridge!', '🌉'); }
}

// ---------------------------------------------------------------------------
// City manager (My Cities)
// ---------------------------------------------------------------------------
function openCityManager() {
  if (!ui.showCityManager) return;
  ui.showCityManager({
    cities: cities.map((c) => ({ id: c.id, name: c.name || 'My City', day: c.day || sim.state.day, pop: c.pop || 0 })),
    currentId,
    onLoad(id) { if (id !== currentId) switchToCity(id); },
    onNew(name) { createCity(name); },
    onRename(id, name) { const c = cities.find((x) => x.id === id); if (c) { c.name = (name || 'My City').slice(0, 20); saveIndex(); } },
    onDelete(id) { deleteCity(id); },
  });
}
function afterCityChange() {
  undoStack.length = 0; growAnims.clear();
  partyIdx = 0; while (partyIdx < POP_PARTY.length && sim.state.pop >= POP_PARTY[partyIdx]) partyIdx++;
  cityNamedFlag = cityName() !== 'Blockville' && cityName() !== 'My City';
  postcardFlag = false;
  rebuildAllVisuals();
  refreshStatsNow();
}
function switchToCity(id) {
  autosave();
  currentId = id; lsSet(CURRENT_KEY, id);
  const raw = lsGet(cityKey(id));
  if (!(raw && sim.load(raw))) { const fresh = new Sim(undefined, models.CATALOG).save(); lsSet(cityKey(id), fresh); sim.load(fresh); }
  afterCityChange();
}
function createCity(name) {
  autosave();
  const id = newCityId();
  cities.push({ id, name: (name || 'My City').slice(0, 20) }); saveIndex();
  const fresh = new Sim(undefined, models.CATALOG).save();
  lsSet(cityKey(id), fresh);
  currentId = id; lsSet(CURRENT_KEY, id);
  sim.load(fresh);
  afterCityChange();
}
function deleteCity(id) {
  if (cities.length <= 1) { ui.toast('Keep at least one city!', '🗂️'); return; }
  lsDel(cityKey(id));
  cities = cities.filter((c) => c.id !== id); saveIndex();
  if (id === currentId) switchToCity(cities[0].id);
  openCityManager();
}
// Save the current in-memory city as a brand-new slot (non-destructive) and
// switch to it. Used when leaving a shared room so nobody's solo city is lost.
function keepAsNewCity(name) {
  const id = newCityId();
  cities.push({ id, name: (name || 'Our City').slice(0, 20) }); saveIndex();
  lsSet(cityKey(id), sim.save());
  currentId = id; lsSet(CURRENT_KEY, id);
  const c = currentCity(); if (c) { c.day = sim.state.day; c.pop = sim.state.pop; saveIndex(); }
}

// ---------------------------------------------------------------------------
// Multiplayer — build one shared city in real time via a room code
// ---------------------------------------------------------------------------
let net = null;
let onlineFlag = false;
let mpPeers = 1;

function startRoom(code) {
  if (net) net.leave();
  onlineFlag = false; mpPeers = 1;
  net = new Net({
    onInit(m) {
      if (m.snapshot) {
        if (sim.load(m.snapshot)) afterCityChange();   // adopt the shared city
      } else if (m.primary) {
        net.sendSnap(sim.save());                        // founding host seeds the room
      }
      onlineFlag = true;
      mpPeers = m.peers || 1;
      ui.setMultiplayer({ online: true, code: net.code, peers: mpPeers, status: 'connected' });
    },
    onOp(op) { applyOp(op); },
    onPeers(n) {
      const grew = n > mpPeers;
      mpPeers = n;
      ui.setMultiplayer({ online: true, code: net.code, peers: n });
      if (grew && onlineFlag) { ui.toast('A friend joined! 🎉', '🤝'); audio.play('milestone'); }
    },
    onSnapRequest() { if (net && net.isOnline()) net.sendSnap(sim.save()); },
    onStatus(s) { ui.setMultiplayer({ online: true, code: net.code, peers: mpPeers, status: s }); },
  });
  net.connect(code);
  ui.setMultiplayer({ online: true, code, peers: 1, status: 'connecting' });
  ui.showMultiplayer();
}
function hostRoom() { startRoom(makeCode()); }
function joinRoom(code) { const c = normalizeCode(code); if (c) startRoom(c); }
function leaveRoom() {
  if (net) net.leave();
  net = null; onlineFlag = false;
  keepAsNewCity('Our City');           // keep what we built together, as a new city
  ui.setMultiplayer({ online: false });
  ui.toast('Left the room — your city is saved! 👋', '👋');
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
let activeTool = null; // null | 'road' | 'tree' | 'bulldoze' | catalog entry
const ui = initUI({
  onTool(tool) {
    activeTool = (tool == null || tool === 'move') ? null : tool;
    ui.setActiveTool((tool == null || tool === 'move') ? 'move' : tool);
    engine.setGhost(null, 0, 0, true);
    if (engine.setGhostCells) engine.setGhostCells(null);
    audio.play('click');
    if (tool && tool.name && speechOn()) speak(tool.name);
  },
  onSpeed(s) { sim.state.speed = s; audio.play('click'); },
  onNew() {
    if (onlineFlag) { ui.toast('Leave the room first!', '🤝'); return; }
    createCity('My City');
    if (mode === 'everything') freeBuild(); else startHelper();
    focusCity();
    ui.toast('New city—fresh map, fresh helper!', '🆕');
  },
  onMute() { return audio.toggleMute(); },
  onUndo() { doUndo(); },
  onPhoto() { takePhoto(); },
  onHelp() { if (ui.showHelpMenu) ui.showHelpMenu(); else ui.showWelcome(); },
  onProjects() { if (ui.showProjects) ui.showProjects(CHALLENGES, startProject); },
  onProject(id) { startProject(id); },
  onRestartHelper() { if (mode === 'everything') applyMode('explorer'); startHelper(); ui.toast('Helper missions restarted!', '🎯'); },
  onMode(nextMode) { applyMode(nextMode || 'explorer'); if (mode === 'everything') freeBuild(); else startHelper(); },
  onFocusCity() { focusCity(); },
  onFreeBuild() { freeBuild(); },
  onMissionNext() { nextMission(); },
  onPalettePick(item) {
    if (!item) { activeTool = null; ui.setActiveTool('move'); return; }
    const tool = item.kind === 'tool' ? item.id : (item.entry || ENTRY_BY_ID[item.id]);
    activeTool = tool === 'move' ? null : tool; ui.setActiveTool(tool === 'move' ? 'move' : tool);
    engine.setGhost(null, 0, 0, true);
    audio.play('click');
    if (speechOn()) speak(item.label || (tool && tool.name) || '');
  },
  onSpeak(text) { if (speechOn()) speak(text); },
  onSpeechToggle(on) { const next = typeof on === 'boolean' ? on : !speechOn(); setSpeech(next); if (next) speak('Read aloud is on!'); return next; },
  onAlwaysBright(on) { const next = typeof on === 'boolean' ? on : !(lsGet(BRIGHT_KEY) === '1'); lsSet(BRIGHT_KEY, next ? '1' : '0'); if (engine.setDaylightLock) engine.setDaylightLock(next); return next; },
  onCities() { if (onlineFlag) { ui.toast('Leave the room first to switch cities.', '🤝'); return; } openCityManager(); },
  onHost() { hostRoom(); },
  onJoin(code) { joinRoom(code); },
  onLeaveRoom() { leaveRoom(); },
});
ui.setCatalog(models.CATALOG);
if (ui.setStickers) ui.setStickers(stickers);

// ---------------------------------------------------------------------------
// Placement feedback + tool input
// ---------------------------------------------------------------------------
function blockedMessage(tool, reason) {
  if (tool === 'tree') return 'Trees need to grow on grass! 🌱';
  if (tool === 'road') return "Roads go on grass, sand, or water. 🛣️";
  if (reason === 'terrain') return 'This building needs grass. 🌿';
  if (reason === 'occupied') return 'Something is already here! 🚧';
  if (reason === 'bounds') return 'This building needs more room. 📏';
  return "That spot won't work — try another! 🙂";
}
function footprintCells(tool, x, z) {
  if (tool && tool.id) {
    const p = sim.plan ? sim.plan(tool, x, z) : null;
    const etw = (p && p.etw) || tool.tw || 1, etd = (p && p.etd) || tool.td || 1;
    const cells = [];
    for (let dz = 0; dz < etd; dz++) for (let dx = 0; dx < etw; dx++) cells.push({ x: x + dx, z: z + dz });
    return cells;
  }
  return [{ x, z }];
}
function showBlocked(tool, x, z, reason) {
  if (engine.flashCells) engine.flashCells(footprintCells(tool, x, z), false);
  if (ui.showBlocked) ui.showBlocked(blockedMessage(tool, reason));
  audio.play('error');
}

const ERASE_MARKER = (() => {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < Math.min(models.PALETTE.length, 200); i++) {
    const c = models.PALETTE[i]; if (c === undefined) continue;
    const d = ((c >> 16 & 255) - 255) ** 2 + ((c >> 8 & 255) - 90) ** 2 + ((c & 255) - 90) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  const blocks = [];
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) if (x === 0 || z === 0 || x === 7 || z === 7) blocks.push([x, 0, z, best]);
  return { sx: 8, sy: 1, sz: 8, blocks };
})();
function ghostArgs(tool, x, z) {
  if (tool === 'road') return { model: models.roadModel(roadMask(x, z)), ok: toolOkAt(tool, x, z), rot: 0 };
  if (tool === 'tree') return { model: models.treeModel(hash2(x, z) % 8), ok: toolOkAt(tool, x, z), rot: 0 };
  if (tool === 'bulldoze') return { model: ERASE_MARKER, ok: toolOkAt(tool, x, z), rot: 0 };
  if (tool && tool.id) {
    const p = sim.plan ? sim.plan(tool, x, z) : { ok: false };
    return { model: models.catalogModel(tool.id, hash2(x, z) % (tool.variants || 1)), ok: !!p.ok, rot: p.ok ? p.rot || 0 : 0 };
  }
  return { model: null, ok: false, rot: 0 };
}
function toolOkAt(tool, x, z) {
  if (!inBounds(x, z)) return false;
  const t = sim.state.map[idx(x, z)];
  if (tool === 'bulldoze') return t !== T.GRASS && t !== T.WATER && t !== T.SAND && t !== T.MOUNTAIN;
  if (tool === 'road') return t === T.GRASS || t === T.SAND || t === T.WATER; // mountains blocked
  if (tool === 'tree') return t === T.GRASS;
  if (tool && tool.id) return !!(sim.plan && sim.plan(tool, x, z).ok);
  return false;
}

function drainNow() { handleEvents(sim.events()); }

// Place a single tile with the active tool. Returns the sim result {ok,reason?}.
// --- ops: the unit of shared, networked action -----------------------------
// Build the op for the active tool at a tile, or a reason it can't go there.
function toolOpAt(tool, tx, tz) {
  if (!inBounds(tx, tz)) return { ok: false, reason: 'bounds' };
  const t = sim.state.map[idx(tx, tz)];
  if (tool === 'road') {
    if (!(t === T.GRASS || t === T.SAND || t === T.WATER)) return { ok: false, reason: 'terrain' };
    return { ok: true, op: { k: 'road', cells: [[tx, tz]] } };
  }
  if (tool === 'tree') {
    if (t !== T.GRASS) return { ok: false, reason: 'terrain' };
    return { ok: true, op: { k: 'tree', x: tx, z: tz } };
  }
  if (tool === 'bulldoze') {
    if (t === T.GRASS || t === T.WATER || t === T.SAND || t === T.MOUNTAIN) return { ok: false, reason: 'empty' };
    return { ok: true, op: { k: 'erase', x: tx, z: tz } };
  }
  if (tool && tool.id) {
    const p = sim.plan ? sim.plan(tool, tx, tz) : { ok: false };
    if (!p.ok) return { ok: false, reason: p.reason };
    return { ok: true, op: { k: 'build', id: tool.id, x: tx, z: tz, v: hash2(tx, tz) % (tool.variants || 1) } };
  }
  return { ok: false };
}

// Apply an op to the sim + visuals (NO networking). Used for both local (offline)
// actions and remote ops arriving in server order — so every player converges.
function announceEffect(entry, before, after) {
  if (!entry || !before || !after) return;
  const bits = [];
  const pop = (after.residents || 0) - (before.residents || 0);
  const jobs = (after.jobs || 0) - (before.jobs || 0);
  const happy = Math.round(((after.happiness || 0) - (before.happiness || 0)) * 100);
  const air = Math.round(((after.air || 0) - (before.air || 0)) * 100);
  if (pop) bits.push('+' + pop + ' people');
  if (jobs) bits.push('+' + jobs + ' jobs');
  if (happy > 0) bits.push('happier neighbors');
  if (air < 0) bits.push('air −' + Math.abs(air) + '%');
  if (air > 0) bits.push('air +' + air + '%');
  if (bits.length) ui.toast((entry.name || 'Building') + ': ' + bits.join(' · '), entry.emoji || '✨');
}

function applyOp(op) {
  if (!op) return;
  if (op.k === 'road') {
    const before = sim.metrics();
    let placed = 0;
    for (const c of op.cells) {
      const x = c[0] | 0, z = c[1] | 0;
      const r = sim.placeRoad(x, z);
      if (r && r.ok) { refreshRoadArea(x, z); engine.refreshTile(sim.state, x, z); placed++; }
    }
    if (placed) {
      audio.play('road');
      const after = sim.metrics();
      if ((after.bridgeCrossings || 0) > (before.bridgeCrossings || 0)) ui.toast('Your bridge connects both river banks!', '🌉');
    }
  } else if (op.k === 'tree') {
    const before = sim.metrics();
    const x = op.x | 0, z = op.z | 0;
    const r = sim.placeTree(x, z);
    if (r && r.ok) {
      engine.addProp('tree', models.treeModel(hash2(x, z) % 8), x, z); audio.play('place');
      const after = sim.metrics();
      const air = Math.round(((after.air || 0) - (before.air || 0)) * 100);
      ui.toast(air > 0 ? ('Tree planted: air +' + air + '%') : 'Tree planted!', '🌳');
    }
  } else if (op.k === 'erase') {
    const x = op.x | 0, z = op.z | 0, prevRoad = sim.state.map[idx(x, z)] === T.ROAD;
    const r = sim.bulldoze(x, z);
    if (r && r.ok) { engine.removeProp('tree', x, z); if (prevRoad) refreshRoadArea(x, z); engine.refreshTile(sim.state, x, z); audio.play('bulldoze'); }
  } else if (op.k === 'build') {
    const e = ENTRY_BY_ID[op.id];
    if (e) {
      const before = sim.metrics();
      const r = sim.place(e, op.x | 0, op.z | 0, op.v | 0);
      if (r && r.ok) { audio.play('built'); announceEffect(e, before, sim.metrics()); }
    }
  }
  drainNow();
  life.sync(sim.state, sim.roadGraph());
}

// Route an action: online → send to the room (applied on echo, in server order);
// offline → apply immediately.
function emitOp(op) {
  if (!op) return;
  if (net && net.isOnline()) net.sendOp(op);
  else applyOp(op);
}

// --- gesture handling -------------------------------------------------------
let painting = false, paintPointer = -1, lastPaint = null;
let roadDrag = null; // { start:{x,z}, cells:[{x,z}...] }
let pendingTile = null, gestureStart = null, lastScreen = null, gestureMoved = false;

// Snap a road drag to a single straight tile line along the dominant axis
// (avoids the isometric staircase). Always includes both endpoints.
function roadLineCells(start, end) {
  const dx = end.x - start.x, dz = end.z - start.z;
  const cells = [];
  if (Math.abs(dx) >= Math.abs(dz)) {
    const n = Math.abs(dx), st = Math.sign(dx);
    for (let i = 0; i <= n; i++) cells.push({ x: start.x + st * i, z: start.z });
  } else {
    const n = Math.abs(dz), st = Math.sign(dz);
    for (let i = 0; i <= n; i++) cells.push({ x: start.x, z: start.z + st * i });
  }
  return cells;
}
function commitRoad() {
  if (!roadDrag) return;
  const cells = roadDrag.cells.map((c) => [c.x, c.z]);
  if (cells.length) emitOp({ k: 'road', cells });
  if (engine.setGhostCells) engine.setGhostCells(null);
  roadDrag = null;
}

function beginGesture(clientX, clientY) {
  const tile = engine.screenToTile(clientX, clientY);
  if (!tile) return;
  if (activeTool === 'road') { roadDrag = { start: tile, cells: [tile] }; if (engine.setGhostCells) engine.setGhostCells([tile], true); return; }
  if (activeTool === 'bulldoze') {
    lastPaint = tile;
    const r = toolOpAt(activeTool, tile.x, tile.z);
    if (r.ok) emitOp(r.op);
    return;
  }
  // Buildings and trees place on TAP only. If the pointer moves, the same
  // gesture pans the camera instead of painting an accidental row of objects.
  pendingTile = tile;
}
function moveGesture(clientX, clientY) {
  const tile = engine.screenToTile(clientX, clientY);
  if (!tile) return;
  if (activeTool === 'road') {
    roadDrag.cells = roadLineCells(roadDrag.start, tile);
    if (engine.setGhostCells) engine.setGhostCells(roadDrag.cells, true);
    return;
  }
  if (activeTool === 'bulldoze' && lastPaint && (lastPaint.x !== tile.x || lastPaint.z !== tile.z)) {
    let x = lastPaint.x, z = lastPaint.z, guard = 0;
    while ((x !== tile.x || z !== tile.z) && guard++ < 160) {
      if (x !== tile.x) x += Math.sign(tile.x - x); else z += Math.sign(tile.z - z);
      const r = toolOpAt(activeTool, x, z); if (r.ok) emitOp(r.op); // silent on invalid during a drag
    }
  }
  lastPaint = tile;
}

window.addEventListener('pointerdown', (e) => {
  audio.initAudio();
  if (e.target !== canvas || !activeTool) return;
  if (painting) { painting = false; return; }
  e.stopPropagation();
  painting = true; paintPointer = e.pointerId; lastPaint = null;
  pendingTile = null; gestureStart = { x: e.clientX, y: e.clientY };
  lastScreen = { x: e.clientX, y: e.clientY }; gestureMoved = false;
  if (!onlineFlag) pushUndo();   // undo is disabled in shared rooms
  beginGesture(e.clientX, e.clientY);
}, { capture: true });

window.addEventListener('pointermove', (e) => {
  if (painting && e.pointerId === paintPointer) {
    e.stopPropagation();
    if (activeTool === 'road' || activeTool === 'bulldoze') {
      moveGesture(e.clientX, e.clientY);
    } else if (gestureStart && lastScreen) {
      const dist = Math.hypot(e.clientX - gestureStart.x, e.clientY - gestureStart.y);
      if (dist > 7) gestureMoved = true;
      if (gestureMoved && engine.panScreen) engine.panScreen(lastScreen.x, lastScreen.y, e.clientX, e.clientY);
      lastScreen = { x: e.clientX, y: e.clientY };
    }
    if (activeTool !== 'road') engine.setGhost(null, 0, 0, true);
    return;
  }
  if (activeTool && e.target === canvas && e.pointerType === 'mouse' && !painting) {
    const tile = engine.screenToTile(e.clientX, e.clientY);
    if (tile) { const g = ghostArgs(activeTool, tile.x, tile.z); engine.setGhost(g.model, tile.x, tile.z, g.ok, g.rot); }
    else engine.setGhost(null, 0, 0, true);
  }
}, { capture: true });

function endPaint(e) {
  if (painting && e.pointerId === paintPointer) {
    e.stopPropagation();
    if (activeTool === 'road') commitRoad();
    else if (activeTool !== 'bulldoze' && !gestureMoved && pendingTile) {
      const r = toolOpAt(activeTool, pendingTile.x, pendingTile.z);
      if (r.ok) emitOp(r.op);
      else if (r.reason && r.reason !== 'empty') showBlocked(activeTool, pendingTile.x, pendingTile.z, r.reason);
    }
    painting = false; lastPaint = null; pendingTile = null; gestureStart = null; lastScreen = null;
  }
}
window.addEventListener('pointerup', endPaint, { capture: true });
window.addEventListener('pointercancel', endPaint, { capture: true });

// Keyboard placement: focus the city canvas, move a tile cursor with arrows,
// and press Enter/Space to build. This keeps the map usable without a pointer.
let keyboardTile = { x: Math.floor(N / 2), z: Math.floor(N / 2) };
canvas.tabIndex = 0;
canvas.setAttribute('aria-label', 'City map. Choose a tool, use arrow keys to move the building cursor, and press Enter to place. Press Escape for Move mode.');
canvas.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 5 : 1;
  let moved = false;
  if (e.key === 'ArrowLeft') { keyboardTile.x = Math.max(0, keyboardTile.x - step); moved = true; }
  else if (e.key === 'ArrowRight') { keyboardTile.x = Math.min(N - 1, keyboardTile.x + step); moved = true; }
  else if (e.key === 'ArrowUp') { keyboardTile.z = Math.max(0, keyboardTile.z - step); moved = true; }
  else if (e.key === 'ArrowDown') { keyboardTile.z = Math.min(N - 1, keyboardTile.z + step); moved = true; }
  else if (e.key === 'Escape') { activeTool = null; ui.setActiveTool('move'); engine.setGhost(null, 0, 0, true); ui.announce('Move mode'); e.preventDefault(); return; }
  else if ((e.key === 'Enter' || e.key === ' ') && activeTool) {
    const r = toolOpAt(activeTool, keyboardTile.x, keyboardTile.z);
    if (r.ok) { if (!onlineFlag) pushUndo(); emitOp(r.op); }
    else if (r.reason && r.reason !== 'empty') showBlocked(activeTool, keyboardTile.x, keyboardTile.z, r.reason);
    e.preventDefault(); return;
  }
  if (moved) {
    e.preventDefault();
    if (engine.focusAt) engine.focusAt(keyboardTile.x, keyboardTile.z, 115);
    if (activeTool) {
      const g = ghostArgs(activeTool, keyboardTile.x, keyboardTile.z);
      engine.setGhost(g.model, keyboardTile.x, keyboardTile.z, g.ok, g.rot);
      ui.announce('Tile ' + (keyboardTile.x + 1) + ', ' + (keyboardTile.z + 1) + (g.ok ? ', ready' : ', blocked'));
    } else ui.announce('Map position ' + (keyboardTile.x + 1) + ', ' + (keyboardTile.z + 1));
  }
});

// ---------------------------------------------------------------------------
// Sim events → visuals / stickers / missions
// ---------------------------------------------------------------------------
const growAnims = new Map();
function handleEvents(events) {
  if (!events || !events.length) return;
  let mapChanged = false;
  for (const ev of events) {
    switch (ev.type) {
      case 'placed': {
        const type = (ev.entry && ev.entry.id) || ev.typeId;
        const model = models.catalogModel(type, ev.variant || 0);
        if (model) { engine.addBuilding(ev.bid, model, ev.x, ev.z, 0.01, ev.rot || 0); growAnims.set(ev.bid, 0); }
        addSpinner(ev.bid, type, ev.x, ev.z, ev.rot || 0, ev.etw || (ev.entry && ev.entry.tw) || 1, ev.etd || (ev.entry && ev.entry.td) || 1);
        recordSticker(type, ev.entry && ev.entry.name);
        placedSinceStart++;
        mapChanged = true;
        break;
      }
      case 'removed': {
        engine.removeBuilding(ev.bid); growAnims.delete(ev.bid); removeSpinner(ev.bid);
        for (let dz = 0; dz < (ev.td || 1); dz++) for (let dx = 0; dx < (ev.tw || 1); dx++) engine.refreshTile(sim.state, ev.x + dx, ev.z + dz);
        mapChanged = true;
        break;
      }
    }
  }
  if (mapChanged) life.sync(sim.state, sim.roadGraph());
}

const POP_PARTY = [50, 150, 300, 500, 1000];
let partyIdx = 0;
function checkParty() {
  while (partyIdx < POP_PARTY.length && sim.state.pop >= POP_PARTY[partyIdx]) {
    ui.celebrate('Hooray! 🎉', `${POP_PARTY[partyIdx]} people live in ${cityName()}!`);
    audio.play('milestone');
    partyIdx++;
  }
}

// ---------------------------------------------------------------------------
// Weather / day-night / main loop
// ---------------------------------------------------------------------------
const SEASON_TINTS = [[1.00, 1.08, 0.96], [1.00, 1.00, 1.00], [1.14, 0.98, 0.76], [1.08, 1.08, 1.18]];
const weather = { rain: 0, snow: 0, targetRain: 0, targetSnow: 0, rolledDay: 0 };
function rollWeather(day) {
  weather.rolledDay = day;
  const season = Math.floor((day - 1) / 3) % 4;
  const r = Math.random();
  weather.targetRain = 0; weather.targetSnow = 0;
  if (season === 3) { if (r < 0.4) weather.targetSnow = 0.6 + Math.random() * 0.4; }
  else if (r < 0.25) weather.targetRain = 0.5 + Math.random() * 0.5;
}
function updateWeather(dt) {
  if (sim.state.day !== weather.rolledDay) rollWeather(sim.state.day);
  const k = Math.min(1, dt / 4);
  weather.rain += (weather.targetRain - weather.rain) * k;
  weather.snow += (weather.targetSnow - weather.snow) * k;
  if (typeof engine.setWeather === 'function') {
    const season = Math.floor((sim.state.day - 1) / 3) % 4;
    engine.setWeather({ tint: SEASON_TINTS[season], rain: weather.rain < 0.02 ? 0 : weather.rain, snow: weather.snow < 0.02 ? 0 : weather.snow });
  }
}
function nightFactor(clock) {
  const c = Math.cos(clock * Math.PI * 2) * 0.5 + 0.5;
  const t = Math.min(1, Math.max(0, (c - 0.35) / 0.4));
  return t * t * (3 - 2 * t);
}
function clockLabel(clock, nt) {
  if (nt > 0.6) return '🌙 Night';
  if (clock < 0.45) return '🌅 Morning';
  if (clock < 0.6) return '🌞 Midday';
  return '🌇 Evening';
}
function refreshStatsNow() {
  const nt = nightFactor(sim.state.clock);
  ui.setStats({ pop: sim.state.pop, jobs: sim.state.jobs, happiness: sim.state.happiness, air: sim.state.air, day: sim.state.day, clockLabel: clockLabel(sim.state.clock, nt) });
}

let last = performance.now();
let statTimer = 0, saveTimer = 0, ambTimer = 0, snapTimer = 0;
function frame(now) { requestAnimationFrame(frame); const dt = Math.min((now - last) / 1000, 0.1); last = now; update(dt); }
function update(dt) {
  const speed = sim.state.speed;
  if (speed > 0) {
    const simDt = dt * speed;
    handleEvents(sim.tick(simDt));
    life.update(simDt, sim.state, sim.roadGraph());
    for (const sp of spinners.values()) { sp.angle += sp.speed * simDt; sp.handle.setSpin(sp.ax, sp.ay, sp.az, sp.angle); }
  }
  updateWeather(dt);

  for (const [id, t] of growAnims) {
    const nt2 = t + dt * 2.5;
    if (nt2 >= 1) { engine.updateBuildingScale(id, 1); growAnims.delete(id); }
    else { const s = 1 + 2.2 * Math.pow(nt2 - 1, 3) + 1.2 * Math.pow(nt2 - 1, 2); engine.updateBuildingScale(id, Math.max(0.01, s)); growAnims.set(id, nt2); }
  }

  const nt = nightFactor(sim.state.clock);
  engine.setNight(nt);

  statTimer += dt;
  if (statTimer > 0.2) {
    statTimer = 0;
    ui.setStats({ pop: sim.state.pop, jobs: sim.state.jobs, happiness: sim.state.happiness, air: sim.state.air, day: sim.state.day, clockLabel: clockLabel(sim.state.clock, nt) });
    checkParty();
    checkMission();
  }
  maybeSuggest(dt);
  ambTimer += dt; if (ambTimer > 1) { ambTimer = 0; audio.setAmbience(nt, sim.state.pop); }
  if (onlineFlag) {
    // In a room: the shared city lives on the server, not local slots. The
    // "primary" player periodically ships a fresh snapshot so late joiners
    // catch up and the server's op backlog stays small.
    if (net && net.isPrimary()) { snapTimer += dt; if (snapTimer > 8) { snapTimer = 0; net.sendSnap(sim.save()); } }
  } else {
    saveTimer += dt; if (saveTimer > 10) { saveTimer = 0; autosave(); }
  }

  engine.render(dt);
}

window.addEventListener('resize', () => engine.resize());

// Debug/console handle
window.BV = {
  sim, engine, life, ui, models, step: update,
  metrics: () => missionMetrics(), mode: () => mode,
  cities: () => cities, openCities: openCityManager,
  paint: (tool, x, z) => {
    activeTool = (typeof tool === 'string' && ENTRY_BY_ID[tool]) ? ENTRY_BY_ID[tool] : tool;
    if (!onlineFlag) pushUndo();
    const r = toolOpAt(activeTool, x, z);
    if (r.ok) emitOp(r.op);
    return r;
  },
  net: () => net, host: hostRoom, join: joinRoom, leaveRoom,
  undo: () => doUndo(), weather,
  ff: (seconds) => {
    for (let t = 0; t < seconds; t += 0.25) { handleEvents(sim.tick(0.25)); life.update(0.25, sim.state, sim.roadGraph()); }
    for (const [id] of growAnims) engine.updateBuildingScale(id, 1);
    growAnims.clear(); engine.render(0.016);
  },
};

// ---------------------------------------------------------------------------
// Go!
// ---------------------------------------------------------------------------
if (lsGet(BRIGHT_KEY) === '1') {
  if (engine.setDaylightLock) engine.setDaylightLock(true);
  if (ui.setBrightState) ui.setBrightState(true);
}
while (partyIdx < POP_PARTY.length && sim.state.pop >= POP_PARTY[partyIdx]) partyIdx++;
cityNamedFlag = cityName() !== 'Blockville' && cityName() !== 'My City';
rebuildAllVisuals();
requestAnimationFrame(frame);

function startFlow() {
  if (!loadedFromSave) ui.showWelcome();
  if (mode !== 'everything') startHelper();
}
const boot = document.getElementById('boot');
setTimeout(() => {
  if (boot) { boot.style.opacity = '0'; setTimeout(() => boot.remove(), 600); }
  if (!mode) { if (ui.showModePicker) ui.showModePicker((m) => { applyMode(m || 'explorer'); startFlow(); }); else { applyMode('explorer'); startFlow(); } }
  else { applyMode(mode); startFlow(); }
}, 400);
