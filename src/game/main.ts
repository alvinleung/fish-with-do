import { toDataURL } from 'qrcode';
import type { Instance as Peer } from 'simple-peer';
import { createLink, sendMsg, fetchRtcConfig } from '../shared/link';
import { postSignal, waitForSignal } from '../shared/signal';
import type { Msg } from '../shared/protocol';
import { MAX_CRANK_RAD_S, clamp } from '../shared/protocol';
import { pickCatch, randomSize, catchById, type CatchDef } from '../shared/catches';
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
const dayEnd = $('dayEnd');
const dayEndTitle = $('dayEndTitle');
const dayEndList1 = $('dayEndList1');
const dayEndList2 = $('dayEndList2');
const dayEndTotal1 = $('dayEndTotal1');
const dayEndTotal2 = $('dayEndTotal2');
const dayEndBtn = $('dayEndBtn') as HTMLButtonElement;
const gameOver = $('gameOver');
const gameOverDays1 = $('gameOverDays1');
const gameOverDays2 = $('gameOverDays2');
const gameOverBest1 = $('gameOverBest1');
const gameOverBest2 = $('gameOverBest2');
const gameOverTotal1 = $('gameOverTotal1');
const gameOverTotal2 = $('gameOverTotal2');
const playAgainBtn = $('playAgainBtn') as HTMLButtonElement;

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
// ---- Day / round: 3-minute days, 3 days per game, then a final screen -------
const DAY_LEN = 90; // seconds per day/round (1.5 minutes)
const TOTAL_DAYS = 3; // days in a game before the final results screen
const DAY_END_STEP = 0.6; // seconds between item reveals on the end screen
const DAY_END_LINGER = 1.6; // pause after the last item before the continue button

type Phase = 'playing' | 'dayEnd' | 'present' | 'gameOver';

// A single item landed in the current day (shown one-by-one on the end screen).
interface DayItem {
  id: string;
  name: string;
  img: string;
  price: number;
  size: number;
}

// A completed day's payout.
interface DayResult {
  money: number;
  count: number;
}

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
  reelR: number; // live crank 0..1 (drives the shared reel sound)
  rodShake: number;
  crankAcc: number;
  crankNotch: number;
  flash: string | null;
  flashT: number;
  dayItems: DayItem[]; // items landed this day (feeds the end-of-day market)
  dayResults: DayResult[]; // completed days, one { money, count } per day
  lastName: string | null;
  presentLanded: boolean; // Kaia (P2) has landed her birthday present this day
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
    reelR: 0,
    rodShake: 0,
    crankAcc: 0,
    crankNotch: 0,
    flash: null,
    flashT: 0,
    dayItems: [],
    dayResults: [],
    lastName: null,
    presentLanded: false,
    bait: null,
  };
}

const players: Player[] = [makePlayer(1, LAYOUTS[0]), makePlayer(2, LAYOUTS[1])];
const G: {
  t: number;
  phase: Phase;
  day: number;
  timeLeft: number;
  dayEndT: number;
} = { t: 0, phase: 'playing', day: 1, timeLeft: DAY_LEN, dayEndT: 0 };

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
// One bottom dialogue box with the character portrait (character.png). Used
// only for the intro: the character greets the player and asks a yes/no
// question. Typewriter reveal with a blinking advance caret. There is no
// dialogue during gameplay — just the brief on-screen result flashes.

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
const CHAR_NAME = 'Hachiware';
const INTRO = {
  lines: ['Hey Kaia, happy birthday!', 'Let\'s go fishing!'],
  question: 'Do you know how to fish?',
  yes: 'Nice! Lean to aim, spin to crank, tap to strike.',
  no: 'No worries — lean to aim, spin to crank, tap to strike.',
};

// introStep: 0 = line 1, 1 = line 2, 2 = question (awaiting a pick), 3 = hint.
let introStep = -1;
let introWaitingChoice = false;
// Play (and the day clock) stays frozen until the Hachiware greeting is over.
let introDone = false;

function sayIntro(text: string): void {
  say(CHAR_NAME, text, { portrait: true, autoHide: false });
}

function startIntro(): void {
  introWaitingChoice = false;
  introStep = 0;
  introDone = false;
  sayIntro(INTRO.lines[0]);
}

function endIntro(): void {
  introStep = -1;
  introWaitingChoice = false;
  introDone = true;
  dlg.active = false;
  dlgChoicesEl.classList.add('hidden');
  dialogueEl.classList.add('hidden');
}

// Kick off the greeting exactly once — fired by a phone "start" or the first P1
// key. The day clock only starts once this convo is over (see introDone).
function beginIntro(): void {
  if (introStep >= 0 || introDone) return;
  startIntro();
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

// ---- Kaia's birthday present: guaranteed, and the day can't end until she lands it
// Day 2 -> Smiski, Day 3 -> iPad. Only Player 2 (Kaia) receives them.
const KAIA_PRESENT: Record<number, string> = { 2: 'smiski', 3: 'ipad' };
const PRESENT_MSG: Record<number, string> = {
  2: 'Psst, Kaia... this little Smiski was never for sale. It has been saved just for you. Happy birthday.',
  3: 'And the big one, Kaia... an iPad, pulled from the deep and kept safe for you. Happy birthday.',
};
let presentStep = -1; // -1 = no present dialogue up; 0 = showing
let presentStartT = 0; // G.t when the reveal started (drives the confetti)

function presentFor(p: Player): string | null {
  return p.id === 2 ? KAIA_PRESENT[G.day] ?? null : null;
}

// The day is held open (overtime, clock frozen) until Kaia has landed her present.
function presentOvertime(): boolean {
  if (G.timeLeft > 0) return false;
  return presentFor(players[1]) !== null && !players[1].presentLanded;
}

function startPresentReveal(day: number): void {
  G.phase = 'present';
  presentStep = 0;
  presentStartT = G.t;
  say(CHAR_NAME, PRESENT_MSG[day] ?? 'Happy birthday, Kaia!', { portrait: true, autoHide: false });
}

// Advance (box tap, space, or a phone tap): skip the typing, or once the line is
// done, close the reveal and resume — ending the day if the clock already ran out.
function presentAdvance(): void {
  if (presentStep < 0 || G.phase !== 'present') return;
  if (!dialogueEl.classList.contains('done')) {
    finishTyping();
    return;
  }
  presentStep = -1;
  dlg.active = false;
  dialogueEl.classList.add('hidden');
  if (G.timeLeft <= 0) startDayEnd();
  else G.phase = 'playing';
}

// A click on the box advances the intro (or Kaia's birthday reveal); the yes/no
// buttons handle their own clicks.
dialogueEl.addEventListener('pointerdown', (e) => {
  if (presentStep >= 0) {
    presentAdvance();
    return;
  }
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
  // Kaia's birthday present: until she lands it, every bite is that present.
  const presentId = presentFor(p);
  const def = presentId && !p.presentLanded ? catchById(presentId) : pickCatch();
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
    if (!p1KeyboardUsed) beginIntro();
    p1KeyboardUsed = true;
  }
  if (k === ' ' && !e.repeat) {
    if (presentStep >= 0) presentAdvance();
    else if (introStep >= 0) introAdvance();
    else handleTap(players[0]);
  }
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
}

function doCatch(p: Player): void {
  const f = p.fish as ActiveFish;
  // Bag the item with its fixed price; the end-of-day market pays it out.
  p.dayItems.push({
    id: f.def.id,
    name: f.def.name,
    img: f.def.img,
    price: f.def.price,
    size: f.size,
  });
  p.lastName = f.def.name;
  p.fish = null;
  p.state = 'caught';
  p.stateT = 0;
  // Settle the fight feedback the instant the fish is in: without this the rod
  // shake and reel read stay frozen mid-fight (noticeable during the paused
  // present reveal, where updatePlayer no longer runs).
  p.reelR = 0;
  p.tension = 0;
  p.rodShake = 0;
  const isPresent = presentFor(p) === f.def.id;
  sendHaptic(p.id, [60, 90, 60]);
  const peer = links[p.id].peer;
  if (peer) sendMsg(peer, { kind: 'catch', id: f.def.id, size: f.size, birthday: isPresent || undefined });
  sfx.catchFish();
  addSparkle(p, p.bobber.x, p.bobber.y, 26);
  if (isPresent) {
    p.presentLanded = true;
    startPresentReveal(G.day);
  } else {
    flash(p, `Player ${p.id} caught a ${f.def.name}!`);
  }
}

function doLose(p: Player, text: string): void {
  flash(p, text);
  p.fish = null;
  p.state = 'lost';
  p.stateT = 0;
  p.reelR = 0;
  p.tension = 0;
  p.rodShake = 0;
  sendHaptic(p.id, 300);
  sfx.lose();
}

// The one big flick, two jobs per player: strike on a bite, otherwise cast.
function handleThrow(p: Player): void {
  sfx.ensure();
  if (G.phase !== 'playing') return;
  if (p.state === 'bite') {
    doStrike(p);
  } else if (p.state === 'idle' || p.state === 'waiting') {
    startCast(p, 1.3);
  }
}

// Tap is only "continue / proceed". Casting and striking are both the throw.
function handleTap(p: Player): void {
  sfx.ensure();
  if (G.phase !== 'playing') return;
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
        doLose(p, 'Player ' + p.id + ': too slow — it got away');
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
        doLose(p, 'Player ' + p.id + ': line snapped!');
        break;
      }
      if (p.progress >= 1) doCatch(p);
      else if (p.progress <= 0) {
        addSplash(p, p.bobber.x, p.bobber.y, 10);
        doLose(p, 'Player ' + p.id + ': it broke free');
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
  // Nothing plays (clock, casts, reeling) until the Hachiware greeting is over.
  if (G.phase === 'playing' && introDone) {
    // The day clock only runs while someone is actually playing.
    if (anyActive()) {
      if (!presentOvertime()) G.timeLeft -= dt;
      if (G.timeLeft <= 0 && !presentOvertime()) startDayEnd();
    }
    for (const p of players) updatePlayer(p, dt);
  } else if (G.phase === 'dayEnd') {
    stepDayEnd(dt);
  }
  stepDialogue(dt);
}

// ---- Render --------------------------------------------------------------------
function sceneView(): Scene {
  return {
    t: G.t,
    timeLeft: G.timeLeft,
    dayProgress: 1 - G.timeLeft / DAY_LEN,
    celebration: G.phase === 'present' ? { elapsed: G.t - presentStartT } : null,
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
      day: G.day,
      dayTotal: TOTAL_DAYS,
      dayItems: p.dayItems.length,
      money: p.dayResults.reduce((s, d) => s + d.money, 0),
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
  // The reel is a single shared loop: silence it whenever the game is paused
  // (present reveal, day end, game over) so a frozen mid-fight reelR can't keep
  // the cranking sound playing.
  sfx.setReel(G.phase === 'playing' ? Math.max(players[0].reelR, players[1].reelR) : 0);
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
    if (presentStep >= 0) presentAdvance();
    else handleTap(players[id - 1]);
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
  beginIntro();
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
    p.reelR = 0;
    p.rodShake = 0;
    p.crankAcc = 0;
    p.crankNotch = 0;
    p.flash = null;
    p.flashT = 0;
    p.dayItems = [];
    p.dayResults = [];
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

// ---- Day / round: settle, end-of-day market, next day, final results --------
function anyActive(): boolean {
  return players.some((p) => p.connected) || p1KeyboardUsed;
}

// Clear in-progress actions (mid-fight / mid-cast) so the pond is calm behind
// the end screen. Players who picked a bait go to 'idle' (ready to cast again);
// anyone still choosing bait stays in 'baiting'.
function settlePlayers(): void {
  for (const p of players) {
    if (p.state !== 'baiting') {
      p.state = 'idle';
      p.stateT = 0;
    }
    p.fish = null;
    p.cast = null;
    p.bursting = false;
    p.burstT = 0;
    p.tension = 0;
    p.progress = 0;
    p.ripples = [];
    p.particles = [];
  }
}

let dayEndShown = 0; // items revealed so far on the current end screen

function startDayEnd(): void {
  G.phase = 'dayEnd';
  G.dayEndT = 0;
  dayEndShown = 0;
  settlePlayers();
  for (const p of players) {
    const money = p.dayItems.reduce((s, it) => s + it.price, 0);
    p.dayResults.push({ money, count: p.dayItems.length });
  }
  dayEndTitle.textContent = `End of Day ${G.day}`;
  dayEndBtn.textContent = G.day < TOTAL_DAYS ? `Start Day ${G.day + 1}` : 'Final results';
  dayEndBtn.classList.add('hidden');
  dayEndList1.innerHTML = '';
  dayEndList2.innerHTML = '';
  dayEndTotal1.textContent = '$0';
  dayEndTotal2.textContent = '$0';
  for (let pi = 0; pi < 2; pi++) {
    const list = pi === 0 ? dayEndList1 : dayEndList2;
    if (players[pi].dayItems.length === 0) {
      const li = document.createElement('li');
      li.className = 'dayend-empty';
      li.textContent = 'No catches this day.';
      list.appendChild(li);
    }
  }
  dayEnd.classList.remove('hidden');
}

function appendDayItem(pi: number, it: DayItem): void {
  const list = pi === 0 ? dayEndList1 : dayEndList2;
  const li = document.createElement('li');
  const img = document.createElement('img');
  img.src = it.img;
  img.alt = it.name;
  const name = document.createElement('span');
  name.textContent = it.name;
  const price = document.createElement('b');
  price.textContent = '+$' + it.price;
  li.append(img, name, price);
  list.appendChild(li);
}

function stepDayEnd(dt: number): void {
  G.dayEndT += dt;
  const lists = [players[0].dayItems, players[1].dayItems];
  const maxItems = Math.max(lists[0].length, lists[1].length);
  const target = Math.min(maxItems, Math.floor(G.dayEndT / DAY_END_STEP));
  if (target > dayEndShown) {
    for (let k = dayEndShown; k < target; k++) {
      for (let pi = 0; pi < 2; pi++) {
        const it = lists[pi][k];
        if (it) {
          appendDayItem(pi, it);
          const running = lists[pi].slice(0, k + 1).reduce((s, x) => s + x.price, 0);
          (pi === 0 ? dayEndTotal1 : dayEndTotal2).textContent = '$' + running;
        }
      }
    }
    dayEndShown = target;
  }
  if (dayEndShown >= maxItems && G.dayEndT - maxItems * DAY_END_STEP >= DAY_END_LINGER) {
    dayEndBtn.classList.remove('hidden');
  }
}

function startNextDay(): void {
  G.day += 1;
  G.timeLeft = DAY_LEN;
  G.dayEndT = 0;
  G.phase = 'playing';
  for (const p of players) {
    p.dayItems = [];
    p.presentLanded = false;
  }
  dayEnd.classList.add('hidden');
}

function showGameOver(): void {
  G.phase = 'gameOver';
  dayEnd.classList.add('hidden');
  for (let pi = 0; pi < 2; pi++) {
    const p = players[pi];
    const daysEl = pi === 0 ? gameOverDays1 : gameOverDays2;
    const bestEl = pi === 0 ? gameOverBest1 : gameOverBest2;
    const totalEl = pi === 0 ? gameOverTotal1 : gameOverTotal2;
    daysEl.innerHTML = '';
    p.dayResults.forEach((r, i) => {
      const li = document.createElement('li');
      li.textContent = `Day ${i + 1}: $${r.money} · ${r.count} item${r.count === 1 ? '' : 's'}`;
      daysEl.appendChild(li);
    });
    const best = p.dayResults.reduce((m, r) => Math.max(m, r.money), 0);
    const total = p.dayResults.reduce((s, r) => s + r.money, 0);
    bestEl.textContent = `Best day: $${best}`;
    totalEl.textContent = `Grand total: $${total}`;
  }
  gameOver.classList.remove('hidden');
}

function startNewGame(): void {
  G.day = 1;
  G.timeLeft = DAY_LEN;
  G.dayEndT = 0;
  G.phase = 'playing';
  for (const p of players) {
    p.dayItems = [];
    p.dayResults = [];
    p.lastName = null;
    p.presentLanded = false;
  }
  gameOver.classList.add('hidden');
  dayEnd.classList.add('hidden');
}

dayEndBtn.addEventListener('click', () => {
  if (G.day < TOTAL_DAYS) startNextDay();
  else showGameOver();
});
playAgainBtn.addEventListener('click', startNewGame);

// Generate the QR codes on load. The Hachiware greeting plays on game start (a
// phone "start" or the first P1 key) — see beginIntro().
startSession();
