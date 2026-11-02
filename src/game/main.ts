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
import './style.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const canvas = $('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const statusEl = $('status');
const debugEl = $('debug');
const newSessionBtn = $('newSessionBtn') as HTMLButtonElement;
const pairPanel = $('pairPanel');
const qrHint = $('qrHint');
const soundHint = $('soundHint') as HTMLButtonElement;

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
  bursting: boolean;
  burstT: number; // time until the next surge (or until the surge ends)
  reelSpeed: number; // 0..1 — where the reeling hook sits on the meter
  bandCenter: number; // 0..1 — center of the drifting sweet-spot band
  bandHalf: number; // 0..~0.16 — half-height of the sweet-spot band
  bandSeed: number; // random phase so each fight's band drift differs
  inSpot: boolean; // is the hook inside the band right now
  progress: number; // 0..1 — net catch progress (1 = landed, 0 = escaped)
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
    reelSpeed: 0.5,
    bandCenter: 0.5,
    bandHalf: 0.14,
    bandSeed: 0,
    inSpot: false,
    progress: 0,
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
  const strength = p.fish?.def.strength ?? 0.5;
  p.state = 'fight';
  p.stateT = 0;
  p.reelSpeed = 0.5;
  p.bandCenter = 0.5;
  // Harder fish get a tighter band that's harder to hold.
  p.bandHalf = clamp(0.17 - strength * 0.08, 0.08, 0.2);
  p.bandSeed = Math.random() * Math.PI * 2;
  p.inSpot = true;
  p.progress = 0.32;
  p.bursting = false;
  p.burstT = 1.4 + Math.random() * 1.6; // first surge comes in a beat
  p.crankAcc = 0;
  p.crankNotch = 0;
  addRipple(p, p.bobber.x, p.bobber.y, 34);
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
}

function doLose(p: Player, text: string): void {
  flash(p, text);
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
      if (t > BITE_WINDOW) doLose(p, 'Player ' + p.id + ': too slow — it got away');
      break;
    }
    case 'fight': {
      const f = p.fish as ActiveFish;
      const strength = f.def.strength;
      const r = clamp(input.v / MAX_CRANK_RAD_S, -1, 1);
      p.reelR = clamp(r, 0, 1);
      if (r > 0) {
        p.crankAcc += r * dt;
        while (p.crankAcc >= NOTCH_RAD) {
          p.crankAcc -= NOTCH_RAD;
          p.crankNotch += NOTCH_RAD;
          sfx.reelTick();
        }
      }

      // Surges: the sweet-spot band periodically whips around much faster.
      p.burstT -= dt;
      if (p.burstT <= 0) {
        if (p.bursting) {
          p.bursting = false;
          p.burstT = 1.6 + Math.random() * 2.8; // calm before the next surge
        } else {
          p.bursting = true;
          p.burstT = 0.6 + Math.random() * 0.5 + strength * 0.5; // surge length
          sfx.surge();
          sendHaptic(p.id, 40);
        }
      }

      // The reeling hook: your crank speed sets where it sits (0 = not turning,
      // 1 = max crank). Smoothed so it tracks the wheel like a spool with weight.
      const target = clamp(r, 0, 1);
      p.reelSpeed += (target - p.reelSpeed) * (1 - Math.exp(-dt * 9));

      // The sweet-spot band drifts up and down; harder fish move it faster.
      // Eased in over the first second so a fresh hook isn't instantly punished.
      const sp = 0.9 + strength * 1.1;
      const t = p.stateT;
      const ramp = Math.min(1, t * 1.2);
      const wave =
        0.5 +
        ramp *
          (0.3 * Math.sin(t * 1.4 * sp + p.bandSeed) +
            0.14 * Math.sin(t * 2.7 * sp + p.bandSeed * 2.3) +
            (p.bursting ? 0.22 * Math.sin(t * 6.5 * sp + p.bandSeed) : 0));
      p.bandCenter = clamp(wave, 0.06, 0.94);

      const inSpot = Math.abs(p.reelSpeed - p.bandCenter) <= p.bandHalf;
      if (inSpot && !p.inSpot) sfx.spotTick();
      p.inSpot = inSpot;

      // In the spot you reel the fish in; outside it the fish recovers.
      if (inSpot) p.progress += dt * 0.24;
      else p.progress -= dt * (0.07 + strength * 0.09);
      p.progress = clamp(p.progress, 0, 1);

      // The fish thrashes more when it's pulling hard, surging, or free of the spot.
      const churn = inSpot ? 0.4 : 1;
      f.phase += dt * (1.4 + (p.bursting ? 2.2 : 0.6) + strength * 0.8) * churn;
      f.x = p.bobberBase.x + Math.sin(f.phase) * (30 + 46 * (p.bursting ? 1 : 0.4));
      f.y = p.bobberBase.y + 42 + Math.cos(f.phase * 1.7) * 12;

      p.bobber.x =
        p.bobberBase.x + Math.sin(f.phase) * 6 + (p.bursting ? Math.sin(G.t * 40) * 4 : 0);
      p.bobber.y = p.bobberBase.y + 8 + Math.sin(f.phase * 1.3) * 3 + (p.bursting ? 6 : 0);
      p.bobberDip = 8;
      p.lineSlack = 0.05 + (p.reelSpeed < 0.15 ? 0.1 : 0);
      p.rodShake = (inSpot ? 0.28 : 0.55) + (p.bursting ? 0.25 : 0) + (r > 0 ? 0.12 : 0);

      if (Math.random() < dt * (1.5 + (p.bursting ? 5 : 0)))
        addRipple(p, p.bobber.x, p.bobber.y, 18);

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
  for (const p of players) updatePlayer(p, dt);
}

// ---- Render --------------------------------------------------------------------
function sceneView(): Scene {
  return {
    t: G.t,
    players: players.map((p) => ({
      id: p.id,
      color: p.layout.color,
      state: p.state,
      rodAngle: p.rodAngle,
      bobber: { ...p.bobber },
      bobberDip: p.bobberDip,
      lineSlack: p.lineSlack,
      ripples: p.ripples,
      particles: p.particles,
      rodShake: p.rodShake,
      reelSpeed: p.reelSpeed,
      bandCenter: p.bandCenter,
      bandHalf: p.bandHalf,
      inSpot: p.inSpot,
      bursting: p.bursting,
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
          ? ' reel=' + p.reelSpeed.toFixed(2) + ' band=' + p.bandCenter.toFixed(2) + ' prog=' + p.progress.toFixed(2)
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
  }
}

function updateStatus(): void {
  const c1 = players[0].connected;
  const c2 = players[1].connected;
  const n = (c1 ? 1 : 0) + (c2 ? 1 : 0);
  statusEl.textContent =
    n === 2
      ? 'Both players connected — happy fishing!'
      : n === 1
        ? 'Fishing! ' + (c1 ? 'P1' : 'P2') + ' is in — scan the other QR to join as a rival.'
        : 'Scan a QR to join — play solo, or add a 2nd phone for 1v1.';
  // Collapse the pairing panel to just the "New codes" button once both are in,
  // so it stops covering the players' HUD corners. A solo player keeps it open
  // so a rival can still scan in later.
  pairPanel.classList.toggle('settled', n === 2);
}

function resetPlayers(): void {
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
    p.reelSpeed = 0.5;
    p.bandCenter = 0.5;
    p.bandHalf = 0.14;
    p.bandSeed = 0;
    p.inSpot = false;
    p.progress = 0;
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
  const urlEl = $('linkUrl' + id) as HTMLInputElement;
  const url = location.origin + '/controller?room=' + code + '&p=' + id;
  const display = 'https://' + location.host + '/controller?room=' + code + '&p=' + id;
  (
    $('roomCode' + id) as HTMLElement
  ).textContent = code;
  urlEl.value = display;
  $('pairPanel').classList.remove('settled');
  void toDataURL(url, { width: 280, margin: 1, errorCorrectionLevel: 'M' }).then((src) => {
    qrEl.src = src;
    (qrEl.parentElement as HTMLElement).classList.remove('hidden');
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
  pairPanel.classList.remove('hidden');
  qrHint.textContent =
    'Player 1 (red) → left code · Player 2 (blue) → right code. Solo or 1v1.';
  updateStatus();
  for (const id of [1, 2] as PlayerId[]) {
    links[id].room = makeRoom();
    setPairUI(id);
    setupPlayerLink(id).catch(() => {});
  }
}

newSessionBtn.addEventListener('click', () => {
  enableSound();
  startSession();
});

for (const id of [1, 2] as PlayerId[]) {
  const btn = $('copyUrlBtn' + id) as HTMLButtonElement;
  btn.addEventListener('click', () => {
    const urlEl = $('linkUrl' + id) as HTMLInputElement;
    void navigator.clipboard?.writeText(urlEl.value).catch(() => {});
    btn.textContent = 'Copied';
    window.setTimeout(() => {
      btn.textContent = 'Copy';
    }, 1400);
  });
}

// Generate the QR codes as soon as the page loads.
startSession();
