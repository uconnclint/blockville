// Blockville audio layer — synthesized WebAudio SFX + inlined background music.
// Cheerful, toy-like blips, plus a rotating playlist of pre-generated music
// loops (base64-inlined from ./music.js, decoded locally — no fetch(), no
// external URLs, same "self-contained" rule as the art assets).
// Everything is wrapped so unsupported / blocked audio never throws.
// Module top-level touches no window / AudioContext (parse-safe in node).

import { MUSIC } from './music.js';

let ctx = null;          // AudioContext (created lazily on first initAudio())
let master = null;       // master GainNode (0.25)
let muted = false;
let started = false;     // did initAudio succeed at least once
const lastPlay = {};     // per-sound rate-limit timestamps

// ---- background music state (lazy; decoded once on first initAudio()) ----
let musicStarted = false;   // did startMusic() already kick off decoding
let musicGain = null;       // GainNode -> master, overall music volume
let musicBusA = null;       // crossfade bus A -> musicGain
let musicBusB = null;       // crossfade bus B -> musicGain
let activeBus = null;       // 'A' | 'B' | null — which bus is currently audible
const musicSrc = { A: null, B: null }; // currently-playing BufferSourceNode per bus
let musicBuffers = null;    // [{ key, buffer }] once decoded
let musicQueue = [];        // shuffled remaining track keys to play
let musicLastKey = null;    // last key played, to avoid an immediate repeat
let musicTimer = null;      // pending setTimeout id for the next crossfade
const CROSSFADE = 2.5;      // seconds of overlap between tracks

// ±3% random pitch wobble so repeats don't grate.
const wob = () => 1 + (Math.random() * 2 - 1) * 0.03;
const now = () => (ctx ? ctx.currentTime : 0);

// ------------------------------------------------------------------
// setup
// ------------------------------------------------------------------
export function initAudio() {
  try {
    if (!ctx) {
      const AC = (typeof window !== 'undefined') &&
        (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;               // no WebAudio -> silent no-op everywhere
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.25;
      master.connect(ctx.destination);
    }
    // Browsers start suspended until a user gesture.
    if (ctx.state === 'suspended' && ctx.resume) {
      ctx.resume().catch(() => {});
    }
    started = true;
    startMusic();                    // lazy; safe to call repeatedly
  } catch (e) {
    /* audio simply unavailable — stay silent */
  }
}

export function toggleMute() {
  try {
    muted = !muted;
    if (master && ctx) {
      const t = now();
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(muted ? 0 : 0.25, t + 0.05);
    }
  } catch (e) { /* ignore */ }
  return muted;
}

// ------------------------------------------------------------------
// low-level helpers
// ------------------------------------------------------------------
// One oscillator note with an attack/decay gain envelope.
function tone(freq, when, dur, {
  type = 'sine', gain = 0.3, attack = 0.005, detune = 0,
  dest = null, glideTo = null,
} = {}) {
  if (!ctx || !master) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, when);
  if (glideTo != null) o.frequency.exponentialRampToValueAtTime(glideTo, when + dur);
  if (detune) o.detune.setValueAtTime(detune, when);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(gain, when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(g);
  g.connect(dest || master);
  o.start(when);
  o.stop(when + dur + 0.02);
}

// Short white/brown noise burst through an optional filter.
function noise(when, dur, {
  gain = 0.2, type = 'highpass', freq = 1000, q = 0.7,
  brown = false, dest = null,
} = {}) {
  if (!ctx || !master) return;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    else d[i] = w;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(gain, when + Math.min(0.02, dur * 0.3));
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(f); f.connect(g); g.connect(dest || master);
  src.start(when);
  src.stop(when + dur + 0.02);
}

// Note-name -> frequency for a few we use (equal temperament).
const F = {
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0,
  B5: 987.77, C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, B6: 1975.53,
};

// ------------------------------------------------------------------
// the sounds
// ------------------------------------------------------------------
const SOUNDS = {
  click(t) {
    tone(660 * wob(), t, 0.06, { type: 'triangle', gain: 0.22, attack: 0.003 });
  },
  place(t) {
    const w = wob();
    tone(F.C5 * w, t, 0.09, { type: 'triangle', gain: 0.28 });
    tone(F.E5 * w, t + 0.07, 0.11, { type: 'triangle', gain: 0.28, detune: 4 });
  },
  road(t) {
    noise(t, 0.07, { gain: 0.16, type: 'bandpass', freq: 1600 * wob(), q: 1.2 });
    tone(180 * wob(), t, 0.05, { type: 'square', gain: 0.06 });
  },
  bulldoze(t) {
    // descending whoosh + crumble noise
    tone(420 * wob(), t, 0.25, { type: 'sawtooth', gain: 0.14, glideTo: 90 });
    noise(t, 0.25, { gain: 0.18, type: 'lowpass', freq: 900, q: 0.6, brown: true });
    noise(t + 0.08, 0.16, { gain: 0.12, type: 'bandpass', freq: 500, q: 0.8 });
  },
  built(t) {
    // cheerful major arpeggio C-E-G + a little sparkle
    const w = wob();
    tone(F.C5 * w, t, 0.12, { type: 'triangle', gain: 0.26 });
    tone(F.E5 * w, t + 0.09, 0.12, { type: 'triangle', gain: 0.26 });
    tone(F.G5 * w, t + 0.18, 0.16, { type: 'triangle', gain: 0.28 });
    tone(F.C6 * w, t + 0.2, 0.12, { type: 'sine', gain: 0.12, detune: 6 });
  },
  upgrade(t) {
    // rising 4-note arpeggio + shimmer
    const w = wob();
    const seq = [F.C5, F.E5, F.G5, F.C6];
    seq.forEach((f, i) => tone(f * w, t + i * 0.07, 0.13,
      { type: 'triangle', gain: 0.24 }));
    tone(F.E6 * w, t + 0.28, 0.18, { type: 'sine', gain: 0.1, detune: 8 });
  },
  milestone(t) {
    // the big one: triumphant fanfare, two detuned saws through a lowpass
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.6;
    lp.connect(master);
    const w = wob();
    const seq = [
      [F.C5, 0.0, 0.18], [F.G5, 0.14, 0.18], [F.C6, 0.28, 0.2],
      [F.E6, 0.42, 0.2], [F.G6, 0.56, 0.34], [F.C6, 0.56, 0.34],
    ];
    for (const [f, off, dur] of seq) {
      tone(f * w, t + off, dur, { type: 'sawtooth', gain: 0.16, detune: -7, dest: lp });
      tone(f * w, t + off, dur, { type: 'sawtooth', gain: 0.16, detune: 7, dest: lp });
    }
    tone(F.C6 * w, t + 0.6, 0.3, { type: 'sine', gain: 0.1 }); // sparkle top
  },
  coin(t) {
    // classic coin ding — two quick sines
    const w = wob();
    tone(F.E6 * w, t, 0.07, { type: 'sine', gain: 0.22 });
    tone(F.B6 * w, t + 0.06, 0.14, { type: 'sine', gain: 0.22 });
  },
  error(t) {
    // gentle low "uh-uh" two-tone down, soft (not harsh)
    const w = wob();
    tone(300 * w, t, 0.12, { type: 'sine', gain: 0.18 });
    tone(240 * w, t + 0.13, 0.16, { type: 'sine', gain: 0.18 });
  },
  piggy(t) {
    // bouncy spring boing (pitch-bend sine) + a coin flourish
    if (ctx && master) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      const base = 220 * wob();
      o.frequency.setValueAtTime(base, t);
      o.frequency.exponentialRampToValueAtTime(base * 3.2, t + 0.08);
      o.frequency.exponentialRampToValueAtTime(base * 1.6, t + 0.18);
      o.frequency.exponentialRampToValueAtTime(base * 2.2, t + 0.26);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.24, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.33);
    }
    SOUNDS.coin(t + 0.28);
    SOUNDS.coin(t + 0.4);
  },
};

export function play(name) {
  try {
    if (!started || !ctx || !master) return;
    const fn = SOUNDS[name];
    if (!fn) return;
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (lastPlay[name] && nowMs - lastPlay[name] < 80) return; // rate-limit 80ms
    lastPlay[name] = nowMs;
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
    fn(now() + 0.001);
  } catch (e) { /* never throw from audio */ }
}

// ------------------------------------------------------------------
// background music — rotating playlist of pre-generated loops, decoded
// from inlined base64 (./music.js) and crossfaded so tracks never hard-cut.
// ------------------------------------------------------------------

// decodeAudioData works both as a Promise API and (older Safari) a
// callback API — support either without throwing.
function decodeAudio(arrayBuffer) {
  return new Promise((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (e) { reject(e); }
  });
}

function base64ToArrayBuffer(dataUri) {
  const b64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function decodeMusicBuffers() {
  const keys = Object.keys(MUSIC || {});
  const results = await Promise.all(keys.map(async (key) => {
    try {
      const buffer = await decodeAudio(base64ToArrayBuffer(MUSIC[key]));
      return { key, buffer };
    } catch (e) { return null; }
  }));
  return results.filter(Boolean);
}

// Pop the next track key off the shuffled queue, reshuffling (and avoiding
// an immediate repeat of the last track) whenever the queue runs dry.
function nextMusicKey() {
  if (!musicQueue.length) {
    const keys = musicBuffers.map((b) => b.key);
    const shuffled = keys.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (shuffled.length > 1 && shuffled[0] === musicLastKey) {
      [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
    }
    musicQueue = shuffled;
  }
  return musicQueue.shift();
}

// Start `key` on the idle crossfade bus while fading the current bus out,
// then schedule the same thing again near the end of this track.
function crossfadeToKey(key) {
  if (!ctx || !musicBuffers) return;
  const entry = musicBuffers.find((b) => b.key === key);
  if (!entry) return;
  musicLastKey = key;

  const targetName = activeBus === 'A' ? 'B' : 'A';
  const targetBus = targetName === 'A' ? musicBusA : musicBusB;
  const oldName = activeBus;
  const oldBus = oldName === 'A' ? musicBusA : (oldName === 'B' ? musicBusB : null);

  const src = ctx.createBufferSource();
  src.buffer = entry.buffer;
  src.connect(targetBus);

  const t = now();
  const fade = Math.min(CROSSFADE, entry.buffer.duration / 2);
  targetBus.gain.cancelScheduledValues(t);
  targetBus.gain.setValueAtTime(0, t);
  targetBus.gain.linearRampToValueAtTime(1, t + fade);
  src.start(t);
  musicSrc[targetName] = src;

  if (oldBus) {
    oldBus.gain.cancelScheduledValues(t);
    oldBus.gain.setValueAtTime(oldBus.gain.value, t);
    oldBus.gain.linearRampToValueAtTime(0, t + fade);
    const oldSrc = musicSrc[oldName];
    if (oldSrc) { try { oldSrc.stop(t + fade + 0.05); } catch (e) { /* ignore */ } }
  }
  activeBus = targetName;

  if (musicTimer) clearTimeout(musicTimer);
  const msUntilNext = Math.max(1000, (entry.buffer.duration - fade) * 1000);
  musicTimer = setTimeout(() => {
    try { crossfadeToKey(nextMusicKey()); } catch (e) { /* ignore */ }
  }, msUntilNext);
}

function startMusic() {
  if (musicStarted || !ctx || !master) return;
  musicStarted = true;
  try {
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.4;      // pre-master music level (master applies 0.25 on top)
    musicGain.connect(master);
    musicBusA = ctx.createGain(); musicBusA.gain.value = 0; musicBusA.connect(musicGain);
    musicBusB = ctx.createGain(); musicBusB.gain.value = 0; musicBusB.connect(musicGain);

    decodeMusicBuffers().then((buffers) => {
      musicBuffers = buffers;
      if (buffers && buffers.length) crossfadeToKey(nextMusicKey());
    }).catch(() => { /* no music available — game stays silent-but-fine */ });
  } catch (e) {
    musicStarted = false; // allow a later retry
  }
}

// ------------------------------------------------------------------
// speech — narration via Web Speech API (defensive, gated, default OFF)
// ------------------------------------------------------------------
let speechEnabled = false;   // module-level gate — DEFAULT OFF
let voiceCache = null;       // cached SpeechSynthesisVoice[] (voices load async)
let voicesBound = false;     // did we attach the voiceschanged listener yet

// speechSynthesis handle, or null when unavailable (parse-safe in node).
function synth() {
  try {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      return window.speechSynthesis;
    }
  } catch (e) { /* ignore */ }
  return null;
}

// Refresh the cached voice list; also bind voiceschanged once so late-loading
// voices get picked up. Never throws.
function refreshVoices() {
  try {
    const s = synth();
    if (!s) return;
    const list = s.getVoices && s.getVoices();
    if (list && list.length) voiceCache = list;
    if (!voicesBound && typeof s.addEventListener === 'function') {
      voicesBound = true;
      s.addEventListener('voiceschanged', () => {
        try {
          const l = s.getVoices && s.getVoices();
          if (l && l.length) voiceCache = l;
        } catch (e) { /* ignore */ }
      });
    }
  } catch (e) { /* ignore */ }
}

// Pick the friendliest available voice: prefer en-US names hinting
// child/female/Samantha/Google US English; else any en-US; else default.
function pickVoice() {
  try {
    refreshVoices();
    const list = voiceCache;
    if (!list || !list.length) return null;
    const hints = ['samantha', 'google us english', 'child', 'female', 'kids', 'karen', 'tessa'];
    const isEnUS = (v) => (v.lang || '').toLowerCase().replace('_', '-').startsWith('en-us');
    // 1) en-US whose name hints friendly/child/female
    for (const h of hints) {
      const m = list.find((v) => isEnUS(v) && (v.name || '').toLowerCase().includes(h));
      if (m) return m;
    }
    // 2) name hint regardless of exact locale (still English preferred)
    for (const h of hints) {
      const m = list.find((v) => (v.name || '').toLowerCase().includes(h)
        && (v.lang || '').toLowerCase().startsWith('en'));
      if (m) return m;
    }
    // 3) any en-US voice
    const enUS = list.find(isEnUS);
    if (enUS) return enUS;
    // 4) any English voice
    const en = list.find((v) => (v.lang || '').toLowerCase().startsWith('en'));
    if (en) return en;
    return null; // let the engine use its default
  } catch (e) {
    return null;
  }
}

export function speak(text) {
  try {
    if (!speechEnabled) return;                 // gated off
    const s = synth();
    if (!s) return;                             // no speechSynthesis support
    const str = (text == null ? '' : String(text)).trim();
    if (!str) return;                           // nothing to say
    if (typeof window.SpeechSynthesisUtterance !== 'function') return;
    // cancel any in-progress / queued utterance first
    if (s.cancel) s.cancel();
    const u = new window.SpeechSynthesisUtterance(str);
    const v = pickVoice();
    if (v) { u.voice = v; if (v.lang) u.lang = v.lang; }
    else u.lang = 'en-US';
    u.rate = 0.95;
    u.pitch = 1.1;
    u.volume = 1;
    s.speak(u);
  } catch (e) { /* never throw from speech */ }
}

export function cancelSpeech() {
  try {
    const s = synth();
    if (s && s.cancel) s.cancel();
  } catch (e) { /* ignore */ }
}

export function setSpeechEnabled(on) {
  try {
    speechEnabled = !!on;
    if (!speechEnabled) cancelSpeech();         // stop anything mid-utterance
  } catch (e) { /* ignore */ }
  return speechEnabled;
}

export function isSpeechEnabled() {
  return speechEnabled;
}

// Kept for API compatibility with main.js's day/night + population loop.
// Background music is now a flat rotating playlist (no day/night or
// population-driven mixing), so this just makes sure the playlist is
// running — nightT/pop are accepted but unused.
export function setAmbience(nightT, pop) {
  try {
    if (!started) return;
    startMusic();
  } catch (e) { /* ignore */ }
}
