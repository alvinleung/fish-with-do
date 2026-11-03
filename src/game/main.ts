import { toDataURL } from 'qrcode';
import type { Instance as Peer } from 'simple-peer';
import { createLink, sendMsg, fetchRtcConfig } from '../shared/link';
import { postSignal, waitForSignal } from '../shared/signal';
import type { Msg } from '../shared/protocol';
import { MAX_CRANK_RAD_S, clamp } from '../shared/protocol';
import { pickCatch, randomSize, type CatchDef } from '../shared/catches';
import {
  W,
  H,
  WATER_Y,
  draw,
  rodAngleFor,
  rodTip,
  setRodUrl,
  type GameState,
  type Scene,
  type Ripple,
  type Particle,
  type PlayerId,
  type PlayerLayout,
} from './render';
import * as sfx from './audio';
import rodImgUrl from '../assets/fishing-rod-black.png';
import characterUrl from '../assets/character.png';
import './style.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const canvas = $('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const statusEl = $('status');
const debugEl = $('debug');
const soundHint = $('soundHint') as HTMLButtonElement;
const pairWrap = $('pairWrap');
const dialogueEl = $('dialogue');
const dlgNameEl = $('dlgName');
const dlgTextEl = $('dlgText');
const dlgPortraitEl = $('dlgPortrait') as HTMLImageElement;
const dlgChoicesEl = $('dlgChoices');
const dlgYesEl = $('dlgYes') as HTMLButtonElement;
const dlgNoEl = $('dlgNo') as HTMLButtonElement;

// True once any phone has pressed "Start game"; the QR screen stays up until then.
let gameStarted = false;

// Browsers block Web Audio until a user gesture on THIS page. Tap the pill (or
// press any key) to unlock the shared sound so solo/phone play isn't silent.
function enableSound(): void {
  sfx.ensure();
  soundHint.classList.add('hidden');
}
soundHint.addEventListener('pointerdown', enableSound);

// The CSS scales the canvas edge-to-edge; render at device resolution so it
// stays crisp. All drawing keeps using the 960x600 world units.
function fitCanvas(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
fitCanvas();
window.addEventListener('resize', fitCanvas);
setRodUrl(rodImgUrl);

// ---- Two players -----------------------------------------------------------
// P1 (red) leans left, P2 (blue) leans right. Each owns a stretch of water and
// a corner of the HUD. The pond, sky and water line are shared.
const LAYOUTS: PlayerLayout[] = [
  {
    id: 1,
    color: '#ff5a5a',
    pivot: { x: 150, y: H + 30 },
    side: -1,
    castMinX: 130,
    castMaxX: 430,
    align: 'left',
    hudX: 20,
  },
  {
    id: 2,
    color: '#4d8bff',
    pivot: { x: 810, y: H + 30 },
    side: 1,
    castMinX: 530,
    castMaxX: 830,
    align: 'right',
    hudX: W - 20,
  },
];

const BITE_WINDOW = 1.4; // seconds you have to strike
const CAST_TIME = 0.8;
const NOTCH_RAD = Math.PI / 6; // 30° — one ratchet click per this much crank

// Fish difficulty ramps with a fish's strength. The base reeling tuning above is
// the floor for weak fish (strength ~0.5 and under); stronger fish need more
// cranking, pull harder, and surge a little more often.
const DIFF = {
  crankK: 1.4, // crankNeed ramp for strength above 0.5
  pullBase: 0.8, // pull scale at zero strength
  pullK: 0.35, // extra pull scale per unit of strength
  calmK: 0.5, // stronger fish surge more often (calm shortened by strength*calmK)
};

interface ActiveFish {
  def: CatchDef;
  size: number;
  x: number;
  y: number;
  dir: 1 | -1;
  phase: number;
}

// Per-player game state. Only the shared clock is global.
interface Player {
  id: PlayerId;
  layout: PlayerLayout;
  connected: boolean;
  state: GameState;
  stateT: number;
  aim: number;
  rodAngle: number;
  bobber: { x: number; y: number };
  bobberBase: { x: number; y: number };
  bobberDip: number;
  lineSlack: number;
  cast: null | { fx: number; fy: number; tx: number; ty: number; t: number; dur: number; arc: number };
  biteT: number;
  fish: ActiveFish | null;
  ripples: Ripple[];
  particles: Particle[];
  bursting: boolean; // is the fish currently surging (pulling much harder)
  burstT: number; // time until the surge state flips
  tension: number; // 0..1 — line tension (1 = the line snaps)
  progress: number; // 0..1 — how reeled in the fish is (1 = landed, 0 = escaped)
  crankNeed: number; // per-fight random: higher = must crank harder to reel in
  lastWarn: number; // last near-snap dialogue time (G.t), for throttling
  reelR: number; // live crank 0..1 (drives the shared reel sound)
  rodShake: number;
  crankAcc: number;
  crankNotch: number;
  flash: string | null;
  flashT: number;
  points: number;
  catchCount: number;
  lastName: string | null;
  bait: string | null;
}

function makePlayer(id: PlayerId, layout: PlayerLayout): Player {
  return {
    id,
    layout,
    connected: false,
    state: 'baiting',
    stateT: 0,
    aim: 0,
    rodAngle: rodAngleFor(0, layout.side),
    bobber: { x: 0, y: 0 },
    bobberBase: { x: 0, y: 0 },
    bobberDip: 0,
    lineSlack: 0.55,
    cast: null,
    biteT: 0,
    fish: null,
    ripples: [],
    particles: [],
    bursting: false,
    burstT: 0,
    tension: 0,
    progress: 0,
    crankNeed: 1,
    lastWarn: 0,
    reelR: 0,
    rodShake: 0,
    crankAcc: 0,
    crankNotch: 0,
    flash: null,
    flashT: 0,
    points: 0,
    catchCount: 0,
    lastName: null,
    bait: null,
  };
}

const players: Player[] = [makePlayer(1, LAYOUTS[0]), makePlayer(2, LAYOUTS[1])];
const G = { t: 0 };

// ---- Per-player effects ----------------------------------------------------
function addRipple(p: Player, x: number, y: number, max: number): void {
  p.ripples.push({ x, y, r: 5, max });
  if (p.ripples.length > 24) p.ripples.shift();
}

function addSplash(p: Player, x: number, y: number, n: number): void {
  for (let i = 0; i < n; i++) {
    p.particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 240,
      vy: -(70 + Math.random() * 190),
      t: 0,
      ttl: 0.5 + Math.random() * 0.4,
      size: 2 + Math.random() * 3,
      color: 'rgba(220,240,255,0.9)',
      kind: 'splash',
    });
  }
}

function addSparkle(p: Player, x: number, y: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 40 + Math.random() * 190;
    p.particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      t: 0,
      ttl: 0.6 + Math.random() * 0.5,
      size: 2 + Math.random() * 3.5,
      color: 'rgba(255,221,87,0.95)',
      kind: 'sparkle',
    });
  }
}

function flash(p: Player, text: string): void {
  p.flash = text;
  p.flashT = 0;
}

// ---- JRPG-style character dialogue ---------------------------------------------
// One bottom dialogue box with an optional character portrait. In-game the
// hooked fish talks (no portrait, auto-hides); the intro shows the character
// (character.png) who greets the player, then asks a yes/no question. Typewriter
// reveal with a blinking advance caret.
const FISH = 'FISH';
const DLG = {
  bite: ['Huph— something\'s got my tail!', 'Oh no, a hook?! Let go!'],
  fight: [
    'Alright, I\'m fightin\' back. Hold on!',
    'This line\'s comin\' for you now.',
    'I\'m not lettin\' go, you hear me!',
  ],
  surge: ['GRR—! I\'m pullin\' HARD, watch it!', 'Easy! I\'m goin\' for a dive!'],
  warn: ['Easy! You\'re about to snap me!', 'Oof— that line\'s gettin\' real tight!'],
  caught: ['Alright alright, you got me. Nice one!', 'Okay, okay— I give! Well reeled.'],
  snapped: ['My line... snapped? Ha! Lucky fish!', 'Snapped clean! You heard it here!'],
  free: ['Too late... *wiggles free*', 'Saw your hand shake. Gone already!'],
};
function pick<T>(arr: T[]): T {
  return arr[(Math.random() * arr.length) | 0];
}

interface DialogueState {
  name: string;
  full: string;
  t: number; // seconds since this line started typing
  holdT: number; // seconds shown after the line finished (auto-hide)
  active: boolean;
  autoHide: boolean; // false keeps the box up (intro) until it's dismissed
  portrait: boolean;
}
const dlg: DialogueState = {
  name: '',
  full: '',
  t: 0,
  holdT: 0,
  active: false,
  autoHide: true,
  portrait: false,
};
const DLG_CPS = 26; // characters per second (typewriter speed)
const DLG_HOLD = 3.2; // linger after a line completes before hiding

function say(
  name: string,
  text: string,
  opts: { portrait?: boolean; autoHide?: boolean } = {}
): void {
  dlg.name = name;
  dlg.full = text;
  dlg.t = 0;
  dlg.holdT = 0;
  dlg.active = true;
  dlg.autoHide = opts.autoHide !== false;
  dlg.portrait = !!opts.portrait;
  dlgNameEl.textContent = name;
  dlgTextEl.textContent = '';
  if (opts.portrait) {
    dlgPortraitEl.src = characterUrl;
    dialogueEl.classList.add('portrait');
  } else {
    dialogueEl.classList.remove('portrait');
  }
  dlgChoicesEl.classList.add('hidden');
  dialogueEl.classList.remove('hidden');
  dialogueEl.classList.remove('done');
}

function stepDialogue(dt: number): void {
  if (!dlg.active) return;
  dlg.t += dt;
  const shown = Math.min(dlg.full.length, Math.floor(dlg.t * DLG_CPS));
  dlgTextEl.textContent = dlg.full.slice(0, shown);
  if (shown >= dlg.full.length) {
    dialogueEl.classList.add('done');
    if (!dlg.autoHide) return; // intro: wait for the player to continue
    dlg.holdT += dt;
    if (dlg.holdT >= DLG_HOLD) {
      dlg.active = false;
      dialogueEl.classList.add('hidden');
    }
  }
}

function finishTyping(): void {
  if (dlg.full && dlg.full.length > 0 && !dialogueEl.classList.contains('done')) {
    dlg.t = dlg.full.length / DLG_CPS;
  }
}

// ---- Intro: the character greets the player, then asks yes/no ------------------
const CHAR_NAME = 'FRIEND'; // TODO: the character's real name
const INTRO = {
  lines: ['Hey Kaia, happy birthday!', 'Let\'s go fishing!'],
  question: 'Do you know how to fish?',
  yes: 'Nice! Lean to aim, spin to crank, tap to strike.',
  no: 'No worries — lean to aim, spin to crank, tap to strike.',
};

// introStep: 0 = line 1, 1 = line 2, 2 = question (awaiting a pick), 3 = hint.
let introStep = -1;
let introWaitingChoice = false;

function sayIntro(text: string): void {
  say(CHAR_NAME, text, { portrait: true, autoHide: false });
}

function startIntro(): void {
  introWaitingChoice = false;
  introStep = 0;
  sayIntro(INTRO.lines[0]);
}

function endIntro(): void {
  introStep = -1;
  introWaitingChoice = false;
  dlg.active = false;
  dlgChoicesEl.classList.add('hidden');
  dialogueEl.classList.add('hidden');
}

function introAdvance(): void {
  if (introStep < 0) return;
  if (!dialogueEl.classList.contains('done')) {
    finishTyping();
    return;
  }
  if (introWaitingChoice) return; // needs a yes/no pick, not a box click
  switch (introStep) {
    case 0:
      introStep = 1;
      sayIntro(INTRO.lines[1]);
      break;
    case 1:
      introStep = 2;
      introWaitingChoice = true;
      sayIntro(INTRO.question);
      dlgChoicesEl.classList.remove('hidden');
      break;
    default:
      break; // hint phase: the box auto-closes
  }
}

function introChoice(yes: boolean): void {
  if (introStep !== 2 || !introWaitingChoice) return;
  introStep = 3;
  introWaitingChoice = false;
  dlgChoicesEl.classList.add('hidden');
  sayIntro(yes ? INTRO.yes : INTRO.no);
  setTimeout(endIntro, 3800);
}

// A click on the box advances the intro; the yes/no buttons handle their own clicks.
dialogueEl.addEventListener('pointerdown', (e) => {
  if (introStep < 0) return;
  if (e.target instanceof Element && e.target.closest('.dlg-choice')) return;
  introAdvance();
});
dlgYesEl.addEventListener('click', (e) => {
  e.stopPropagation();
  introChoice(true);
});
dlgNoEl.addEventListener('click', (e) => {
  e.stopPropagation();
  introChoice(false);
});

function scheduleBite(p: Player): void {
  p.biteT = 2.5 + Math.random() * 5;
  const def = pickCatch();
  p.fish = {
    def,
    size: randomSize(def),
    x: p.layout.castMinX + Math.random() * (p.layout.castMaxX - p.layout.castMinX),
    y: WATER_Y + 70 + Math.random() * 130,
    dir: 1,
    phase: Math.random() * 6.28,
  };
}

// ---- Input -----------------------------------------------------------------
const links: Record<PlayerId, { peer: Peer | null; room: string; pollAbort: AbortController | null }> = {
  1: { peer: null, room: '', pollAbort: null },
  2: { peer: null, room: '', pollAbort: null },
};

// Latest frame from each phone; P1 also has a keyboard fallback for desktop.
const phones: Record<PlayerId, { x: number; y: number; v: number; frames: number }> = {
  1: { x: 0, y: 0, v: 0, frames: 0 },
  2: { x: 0, y: 0, v: 0, frames: 0 },
};
const keys = new Set<string>();
const KEY_X: Record<string, number> = { a: -1, arrowleft: -1, d: 1, arrowright: 1 };
// P1 has a keyboard fallback for desktop; set once any P1 key is pressed so an
// unpaired (no-phone) P1 still reveals its rod when someone starts playing it.
let p1KeyboardUsed = false;

function readInputFor(id: PlayerId): { x: number; v: number } {
  const ph = phones[id];
  if (id === 1) {
    let kx = 0;
    keys.forEach((k) => {
      kx += KEY_X[k] ?? 0;
    });
    const crank =
      keys.has('w') || keys.has('arrowup')
        ? MAX_CRANK_RAD_S
        : keys.has('s') || keys.has('arrowdown')
          ? -MAX_CRANK_RAD_S * 0.6
          : 0;
    return { x: kx !== 0 ? clamp(kx, -1, 1) : ph.x, v: crank !== 0 ? crank : ph.v };
  }
  return { x: ph.x, v: ph.v };
}

window.addEventListener('keydown', (e) => {
  enableSound();
  const k = e.key.toLowerCase();
  if (KEY_X[k] !== undefined || ['w', 's', 'arrowup', 'arrowdown', ' ', 't'].includes(k)) {
    p1KeyboardUsed = true;
  }
  if (k === ' ' && !e.repeat) handleTap(players[0]);
  if (k === 't' && !e.repeat) handleThrow(players[0]);
  if (KEY_X[k] !== undefined || ['w', 's', 'arrowup', 'arrowdown'].includes(k) || k === ' ') {
    keys.add(k);
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

function sendHaptic(id: PlayerId, ms: number | number[]): void {
  const peer = links[id].peer;
  if (peer) sendMsg(peer, { kind: 'haptic', ms });
}

// ---- State machine -----------------------------------------------------------
function startCast(p: Player, power = 1): void {
  const L = p.layout;
  const t01 = (clamp(p.aim, -1, 1) + 1) / 2; // 0..1 across this player's water
  const tx = L.castMinX + (L.castMaxX - L.castMinX) * t01;
  const ty = WATER_Y + 24 + 90 * (1 - t01);
  p.cast = {
    fx: p.bobber.x,
    fy: p.bobber.y,
    tx,
    ty,
    t: 0,
    dur: CAST_TIME / Math.sqrt(power),
    arc: 150 + (power - 1) * 180,
  };
  p.state = 'casting';
  p.stateT = 0;
}

function doStrike(p: Player): void {
  if (p.state !== 'bite') return;
  p.state = 'fight';
  p.stateT = 0;
  p.tension = 0.3;
  p.progress = 0.15;
  p.bursting = false;
  p.burstT = 1.2 + Math.random() * 1.0; // first surge comes in a beat
  // Base crank requirement, ramped up for stronger fish (weak fish stay at base).
  const s = (p.fish as ActiveFish).def.strength;
  p.crankNeed = (1 + Math.max(0, s - 0.5) * DIFF.crankK) * (1 + Math.random() * 0.6);
  p.crankAcc = 0;
  p.crankNotch = 0;
  addRipple(p, p.bobber.x, p.bobber.y, 34);
  say(FISH, pick(DLG.fight));
}

function doCatch(p: Player): void {
  const f = p.fish as ActiveFish;
  p.points += f.def.points;
  p.catchCount += 1;
  p.lastName = f.def.name;
  p.fish = null;
  p.state = 'caught';
  p.stateT = 0;
  sendHaptic(p.id, [60, 90, 60]);
  const peer = links[p.id].peer;
  if (peer) sendMsg(peer, { kind: 'catch', id: f.def.id, size: f.size });
  sfx.catchFish();
  addSparkle(p, p.bobber.x, p.bobber.y, 26);
  flash(p, `Player ${p.id} caught a ${f.def.name}!`);
  say(FISH, pick(DLG.caught));
}

function doLose(p: Player, text: string, fishLine?: string): void {
  flash(p, text);
  if (fishLine) say(FISH, fishLine);
  p.fish = null;
  p.state = 'lost';
  p.stateT = 0;
  sendHaptic(p.id, 300);
  sfx.lose();
}

// The one big flick, two jobs per player: strike on a bite, otherwise cast.
function handleThrow(p: Player): void {
  sfx.ensure();
  if (p.state === 'bite') {
    doStrike(p);
  } else if (p.state === 'idle' || p.state === 'waiting') {
    startCast(p, 1.3);
  }
}

// Tap is only "continue / proceed". Casting and striking are both the throw.
function handleTap(p: Player): void {
  sfx.ensure();
  if (p.state === 'baiting') {
    p.bait = p.bait ?? 'worm';
    p.state = 'idle';
    p.stateT = 0;
  } else if (p.state === 'caught') {
    p.state = 'baiting';
    p.stateT = 0;
  } else if (p.state === 'lost') {
    p.state = 'idle';
    p.stateT = 0;
  }
}

// ---- Update --------------------------------------------------------------------
function updatePlayer(p: Player, dt: number): void {
  p.stateT += dt;
  p.reelR = 0;
  p.rodShake = 0;
  if (p.flash) {
    p.flashT += dt / 1.8;
    if (p.flashT >= 1) p.flash = null;
  }
  for (const r of p.ripples) r.r += 55 * dt;
  p.ripples = p.ripples.filter((r) => r.r < r.max);
  for (const pt of p.particles) {
    pt.t += dt;
    if (pt.kind === 'splash') pt.vy += 520 * dt;
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
  }
  p.particles = p.particles.filter((pt) => pt.t < pt.ttl);
  if (p.particles.length > 200) p.particles.splice(0, p.particles.length - 200);

  const input = readInputFor(p.id);
  p.aim += (input.x - p.aim) * (1 - Math.exp(-dt * 6));
  p.rodAngle += (rodAngleFor(p.aim, p.layout.side) - p.rodAngle) * (1 - Math.exp(-dt * 7));
  const L = p.layout;

  switch (p.state) {
    case 'baiting':
    case 'idle': {
      const tip = rodTip(p.rodAngle, L.pivot);
      p.bobber.x = tip.x;
      p.bobber.y = tip.y + 66 + Math.sin(G.t * 1.6) * 4;
      p.bobberDip = 0;
      break;
    }
    case 'casting': {
      if (!p.cast) {
        p.state = 'idle';
        break;
      }
      p.cast.t += dt;
      const k = Math.min(1, p.cast.t / p.cast.dur);
      p.bobber.x = p.cast.fx + (p.cast.tx - p.cast.fx) * k;
      p.bobber.y =
        p.cast.fy + (p.cast.ty - p.cast.fy) * k - Math.sin(k * Math.PI) * p.cast.arc;
      if (k >= 1) {
        p.bobber.x = p.cast.tx;
        p.bobber.y = p.cast.ty;
        p.bobberBase = { x: p.cast.tx, y: p.cast.ty };
        p.cast = null;
        p.state = 'waiting';
        p.stateT = 0;
        p.bobberDip = 0;
        scheduleBite(p);
        addRipple(p, p.bobber.x, p.bobber.y, 26);
        addSplash(p, p.bobber.x, p.bobber.y, 8);
        sfx.splash();
      }
      break;
    }
    case 'waiting': {
      if (Math.random() < dt * 0.7) addRipple(p, p.bobber.x, p.bobber.y, 16);
      p.bobberDip = 0;
      p.lineSlack = 0.5 + Math.sin(G.t * 1.3) * 0.05;
      p.biteT -= dt;
      if (p.biteT <= 0) {
        p.state = 'bite';
        p.stateT = 0;
        sfx.bite();
        sendHaptic(p.id, 80);
        say(FISH, pick(DLG.bite));
      }
      break;
    }
    case 'bite': {
      const t = p.stateT;
      const dip = Math.max(0, Math.sin(t * 26)) * (14 + 10 * Math.min(1, t / BITE_WINDOW));
      p.bobber.x = p.bobberBase.x + Math.sin(t * 30) * 3;
      p.bobber.y = p.bobberBase.y + dip;
      p.bobberDip = dip;
      p.lineSlack = 0.06;
      if (t < 0.5) {
        for (let i = 0; i < 2; i++) {
          p.particles.push({
            x: p.bobber.x,
            y: p.bobberBase.y,
            vx: (Math.random() - 0.5) * 180,
            vy: -(60 + Math.random() * 160),
            t: 0,
            ttl: 0.5 + Math.random() * 0.3,
            size: 2 + Math.random() * 2.5,
            color: 'rgba(220,240,255,0.9)',
            kind: 'splash',
          });
        }
      }
      if (t < 0.4 && Math.random() < dt * 30) addRipple(p, p.bobber.x, p.bobberBase.y, 20);
      p.rodShake = Math.min(1, t * 3);
      if (t > BITE_WINDOW)
        doLose(p, 'Player ' + p.id + ': too slow — it got away', pick(DLG.free));
      break;
    }
    case 'fight': {
      const f = p.fish as ActiveFish;
      const strength = f.def.strength;
      const r = clamp(input.v / MAX_CRANK_RAD_S, -1, 1);
      const lo = clamp(-r, 0, 1); // slack: cranking backwards lets line out
      p.reelR = clamp(r, 0, 1);
      if (r > 0) {
        p.crankAcc += r * dt;
        while (p.crankAcc >= NOTCH_RAD) {
          p.crankAcc -= NOTCH_RAD;
          p.crankNotch += NOTCH_RAD;
          sfx.reelTick();
        }
      }

      // Surges: the fish periodically whips around and pulls much harder. Ease
      // off during a surge or the line tension spikes toward a snap.
      p.burstT -= dt;
      if (p.burstT <= 0) {
        p.bursting = !p.bursting;
        p.burstT = p.bursting
          ? 0.7 + Math.random() * 0.7 + strength * 0.6 // surge length
          : 1.6 - strength * DIFF.calmK + Math.random() * 2.2; // calm (stronger = shorter)
        if (p.bursting) {
          sfx.surge();
          sendHaptic(p.id, 40);
          if (Math.random() < 0.5) say(FISH, pick(DLG.surge));
        }
      }
      const burst = p.bursting ? 1 : 0;

      // The fish's pull: two overlapping beats that ramp in over the first
      // second, plus a big hit while surging.
      f.phase += dt * (1.6 + 2.4 * burst);
      const f2 = Math.min(1, p.stateT * 1.2);
      const pull =
        (Math.max(0, Math.sin(f.phase * 0.9)) * (0.55 + 0.45 * f2) +
          Math.max(0, Math.sin(f.phase * 2.3 + 1)) * 0.5 * f2 +
          burst * 0.5) *
        (DIFF.pullBase + strength * DIFF.pullK); // stronger fish pull harder

      // Tension: cranking against a pull builds it; easing off (or slacking)
      // lets it bleed off. Hit 1 and the line snaps.
      p.tension += dt * (r * (0.3 + 0.75 * pull) - 0.62 - 0.8 * lo);
      p.tension = clamp(p.tension, 0, 1);
      if (p.tension > 0.78 && G.t - p.lastWarn > 3 && Math.random() < 0.5) {
        p.lastWarn = G.t;
        say(FISH, pick(DLG.warn));
      }
      // Progress: crank to reel the fish in; it recovers when you're not cranking
      // hard, and slacking loses ground. Reeling is intentionally slow (base
      // 0.24) and this fight's random crankNeed makes some fish demand more.
      p.progress += dt * ((0.24 / p.crankNeed) * r - 0.2 * pull * (1 - 0.8 * r) - 0.1 * lo);
      p.progress = clamp(p.progress, 0, 1);

      // Thrash + rod feedback scale with the pull and how close the line is to
      // snapping.
      f.x = p.bobberBase.x + Math.sin(f.phase) * (34 + 44 * burst);
      f.y = p.bobberBase.y + 42 + Math.cos(f.phase * 1.7) * 12;
      p.bobber.x =
        p.bobberBase.x + Math.sin(f.phase) * 6 + (burst ? Math.sin(G.t * 40) * 4 : 0);
      p.bobber.y = p.bobberBase.y + 6 + Math.sin(f.phase * 1.1) * 2 + (burst ? 3 : 0);
      p.bobberDip = 8;
      p.lineSlack = 0.05 + (lo > 0.2 ? lo * 0.12 : 0);
      p.rodShake = 0.28 + 0.5 * burst + (r > 0 ? 0.14 : 0) + (p.tension > 0.7 ? 0.18 : 0);

      if (Math.random() < dt * (1.5 + burst * 5)) addRipple(p, p.bobber.x, p.bobber.y, 18);

      if (p.tension >= 1) {
        addRipple(p, p.bobber.x, p.bobber.y, 30);
        doLose(p, 'Player ' + p.id + ': line snapped!', pick(DLG.snapped));
        break;
      }
      if (p.progress >= 1) doCatch(p);
      else if (p.progress <= 0) {
        addSplash(p, p.bobber.x, p.bobber.y, 10);
        doLose(p, 'Player ' + p.id + ': it broke free', pick(DLG.free));
      }
      break;
    }
    case 'caught': {
      const tip = rodTip(p.rodAngle, L.pivot);
      p.bobber.x = tip.x;
      p.bobber.y = tip.y + 66;
      p.bobberDip = 0;
      // Auto-return so a phone that disconnects mid-celebration can't strand
      // its player here forever.
      if (p.stateT > 8) {
        p.state = 'baiting';
        p.stateT = 0;
      }
      break;
    }
    case 'lost': {
      const tip = rodTip(p.rodAngle, L.pivot);
      p.bobber.x = tip.x;
      p.bobber.y = tip.y + 66;
      p.bobberDip = 0;
      // Brief "it got away" beat (shown as a flash on this screen), then back
      // to idle so the phone can cast again without a tap.
      if (p.stateT > 2.2) {
        p.state = 'idle';
        p.stateT = 0;
      }
      break;
    }
  }
}

function update(dt: number): void {
  G.t += dt;
  for (const p of players) updatePlayer(p, dt);
  stepDialogue(dt);
}

// ---- Render --------------------------------------------------------------------
function sceneView(): Scene {
  return {
    t: G.t,
    players: players.map((p) => ({
      id: p.id,
      color: p.layout.color,
      visible: p.connected || (p.id === 1 && p1KeyboardUsed),
      state: p.state,
      rodAngle: p.rodAngle,
      bobber: { ...p.bobber },
      lineSlack: p.lineSlack,
      ripples: p.ripples,
      particles: p.particles,
      rodShake: p.rodShake,
      tension: p.tension,
      progress: p.progress,
      points: p.points,
      catchCount: p.catchCount,
      lastName: p.lastName,
      flash: p.flash,
      flashT: p.flash ? Math.min(1, p.flashT) : 0,
      layout: p.layout,
    })),
  };
}

function debugInfo(): void {
  const desc = (id: PlayerId) => {
    const p = players[id - 1];
    return (
      'P' +
      id +
      (p.connected ? '●' : '○') +
      ' ' +
      p.state +
        (p.state === 'fight'
          ? ' tens=' + p.tension.toFixed(2) + ' prog=' + p.progress.toFixed(2)
          : '')
    );
  };
  debugEl.textContent =
    'T throw (cast / strike) · W/S crank · Space continue (P1 keys)\n' +
    desc(1) + '   |   ' + desc(2) + '\n' +
    'P1 frames=' + phones[1].frames + '  P2 frames=' + phones[2].frames;
}

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  sfx.setReel(Math.max(players[0].reelR, players[1].reelR));
  draw(ctx, sceneView());
  debugInfo();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---- Pairing: two independent links, one per player -----------------------------
function makeRoom(): string {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += a[(Math.random() * a.length) | 0];
  return s;
}

// Drop loopback ICE candidates before shipping the offer through the relay.
function trimSdp(sdp: string): string {
  return sdp
    .split('\n')
    .filter((line) => !line.startsWith('a=candidate:') || !line.includes(' 127.0.0.1 '))
    .join('\n');
}

// Create the game-side (offerer) peer for one player, publish the offer, then
// resolve once the answer arrives and the data channel is open.
function setupPlayerLink(id: PlayerId): Promise<void> {
  const L = links[id];
  L.pollAbort?.abort();
  const abort = new AbortController();
  L.pollAbort = abort;
  // The room was already minted in startSession (so the QR can carry it).
  const room = L.room;

  return fetchRtcConfig().then((config) => {
    const peer = createLink({
      initiator: true,
      config,
      onSignal: (sig) => {
        const s = sig as { type?: string; sdp?: string };
        if (s?.type === 'offer' && s.sdp) {
          void postSignal(
            room,
            'offer',
            JSON.stringify({ type: 'offer', sdp: trimSdp(s.sdp) })
          ).catch(() => {});
        }
      },
      onOpen: () => {
        const p = players[id - 1];
        p.connected = true;
        updateStatus();
      },
      onData: (m) => handleData(id, m),
      onClose: () => {
        links[id].peer = null;
        players[id - 1].connected = false;
        phones[id].frames = 0;
        phones[id].x = 0;
        phones[id].y = 0;
        phones[id].v = 0;
        updateStatus();
      },
      onError: () => {},
    });
    L.peer = peer;
    return waitForSignal(room, 'answer', abort.signal).then((answer) => {
      if (abort.signal.aborted) throw new Error('aborted');
      peer.signal(JSON.parse(answer));
      return new Promise<void>((resolve, reject) => {
        peer.on('connect', () => resolve());
        peer.on('error', () => reject(new Error('connect failed')));
      });
    });
  });
}

function handleData(id: PlayerId, m: Msg): void {
  if (m.kind === 'ctrl') {
    const ph = phones[id];
    ph.x = m.x;
    ph.y = m.y;
    ph.v = m.v;
    ph.frames += 1;
  } else if (m.kind === 'tap') {
    handleTap(players[id - 1]);
  } else if (m.kind === 'throw') {
    handleThrow(players[id - 1]);
  } else if (m.kind === 'bait') {
    players[id - 1].bait = m.id;
    handleTap(players[id - 1]);
  } else if (m.kind === 'start') {
    onPlayerStart();
  }
}

// A phone pressed "Start game" — the pairing phase is over, so dismiss the QR
// screen and free up the whole pond.
function onPlayerStart(): void {
  if (gameStarted) return;
  gameStarted = true;
  pairWrap.classList.add('hidden');
  updateStatus();
}

function updateStatus(): void {
  const c1 = players[0].connected;
  const c2 = players[1].connected;
  const n = (c1 ? 1 : 0) + (c2 ? 1 : 0);
  statusEl.textContent = gameStarted
    ? 'Fishing!'
    : n === 2
      ? 'Both players in — press Start on your phones.'
      : n === 1
        ? (c1 ? 'P1' : 'P2') + ' is in — scan the other QR to join (or play solo).'
        : 'Scan a QR to join — play solo, or add a 2nd phone for 1v1.';
}

function resetPlayers(): void {
  gameStarted = false;
  p1KeyboardUsed = false;
  for (const p of players) {
    p.connected = false;
    p.state = 'baiting';
    p.stateT = 0;
    p.aim = 0;
    p.rodAngle = rodAngleFor(0, p.layout.side);
    p.bobber = { x: 0, y: 0 };
    p.bobberBase = { x: 0, y: 0 };
    p.bobberDip = 0;
    p.lineSlack = 0.55;
    p.cast = null;
    p.biteT = 0;
    p.fish = null;
    p.ripples = [];
    p.particles = [];
    p.bursting = false;
    p.burstT = 0;
    p.tension = 0;
    p.progress = 0;
    p.crankNeed = 1;
    p.lastWarn = 0;
    p.reelR = 0;
    p.rodShake = 0;
    p.crankAcc = 0;
    p.crankNotch = 0;
    p.flash = null;
    p.flashT = 0;
    p.points = 0;
    p.catchCount = 0;
    p.lastName = null;
    p.bait = null;
  }
  phones[1] = { x: 0, y: 0, v: 0, frames: 0 };
  phones[2] = { x: 0, y: 0, v: 0, frames: 0 };
}

function setPairUI(id: PlayerId): void {
  const code = links[id].room;
  const qrEl = $('pairQR' + id) as HTMLImageElement;
  const url = location.origin + '/controller?room=' + code + '&p=' + id;
  void toDataURL(url, { width: 280, margin: 1, errorCorrectionLevel: 'M' }).then((src) => {
    qrEl.src = src;
  });
}

function startSession(): void {
  resetPlayers();
  for (const p of players) {
    const L = links[p.id];
    L.pollAbort?.abort();
    L.peer = null;
    L.room = '';
  }
  pairWrap.classList.remove('hidden');
  updateStatus();
  for (const id of [1, 2] as PlayerId[]) {
    links[id].room = makeRoom();
    setPairUI(id);
    setupPlayerLink(id).catch(() => {});
  }
}

// Generate the QR codes as soon as the page loads, then play the intro.
startSession();
startIntro();
