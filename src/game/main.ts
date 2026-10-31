import { toDataURL } from 'qrcode';
import type { Instance as Peer } from 'simple-peer';
import { createLink, sendMsg } from '../shared/link';
import { postSignal, waitForSignal } from '../shared/signal';
import type { Msg } from '../shared/protocol';
import { MAX_CRANK_RAD_S, clamp } from '../shared/protocol';
import { CATCHES, pickCatch, randomSize, type CatchDef } from './fish';
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
  type FishView,
  type Ripple,
} from './render';
import rodImgUrl from '../assets/fishing-rod-black.png';
import './style.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const canvas = $('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const statusEl = $('status');
const debugEl = $('debug');
const newSessionBtn = $('newSessionBtn') as HTMLButtonElement;
const pairPanel = $('pairWrap');
const pairQR = $('pairQR') as HTMLImageElement;
const roomCodeEl = $('roomCode');
const qrHint = $('qrHint');
const linkUrl = $('linkUrl') as HTMLInputElement;
const copyUrlBtn = $('copyUrlBtn') as HTMLButtonElement;
const resultOverlay = $('resultOverlay');
const resultImg = $('resultImg') as HTMLImageElement;
const resultName = $('resultName');
const resultDetail = $('resultDetail');
const againBtn = $('againBtn') as HTMLButtonElement;

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

// ---- Game state ------------------------------------------------------------
const BITE_WINDOW = 1.4; // seconds you have to strike
const CAST_TIME = 0.8;

interface ActiveFish {
  def: CatchDef;
  size: number;
  x: number;
  y: number;
  dir: 1 | -1;
  phase: number;
}

interface AmbientFish {
  img: string;
  x: number;
  y: number;
  baseY: number;
  size: number;
  dir: 1 | -1;
  speed: number;
  phase: number;
}

const S = {
  t: 0,
  state: 'idle' as GameState,
  stateT: 0,
  aim: 0,
  rodAngle: rodAngleFor(0),
  bobber: { x: 0, y: 0 },
  bobberBase: { x: 0, y: 0 },
  bobberDip: 0,
  lineSlack: 0.55,
  cast: null as null | { fx: number; fy: number; tx: number; ty: number; t: number; dur: number; arc: number },
  biteT: 0,
  fish: null as ActiveFish | null,
  ambient: [] as AmbientFish[],
  ripples: [] as Ripple[],
  bursting: false,
  burstT: 0,
  tension: 0,
  progress: 0,
  flash: null as string | null,
  flashT: 0,
  points: 0,
  catchCount: 0,
  lastName: null as string | null,
};

function spawnAmbient(): void {
  const fishDefs = CATCHES.filter((c) => c.kind === 'fish');
  S.ambient = Array.from({ length: 3 }, (_, i) => {
    const def = fishDefs[(i + Math.floor(Math.random() * fishDefs.length)) % fishDefs.length];
    const baseY = WATER_Y + 70 + Math.random() * (H - WATER_Y - 130);
    return {
      img: def.img,
      x: Math.random() * W,
      y: baseY,
      baseY,
      size: 34 + Math.random() * 26,
      dir: Math.random() < 0.5 ? 1 : -1,
      speed: 18 + Math.random() * 26,
      phase: Math.random() * 6.28,
    };
  });
}

function addRipple(x: number, y: number, max: number): void {
  S.ripples.push({ x, y, r: 5, max });
  if (S.ripples.length > 24) S.ripples.shift();
}

function flash(text: string): void {
  S.flash = text;
  S.flashT = 0;
}

function scheduleBite(): void {
  S.biteT = 2.5 + Math.random() * 5;
  const def = pickCatch();
  S.fish = {
    def,
    size: randomSize(def),
    x: 60 + Math.random() * 320,
    y: WATER_Y + 70 + Math.random() * 130,
    dir: 1,
    phase: Math.random() * 6.28,
  };
}

// ---- Input -----------------------------------------------------------------
let peer: Peer | null = null;

// Latest frame from the phone; keyboard overrides it for desktop testing.
const phone = { x: 0, y: 0, v: 0, frames: 0 };
const keys = new Set<string>();
const KEY_X: Record<string, number> = { a: -1, arrowleft: -1, d: 1, arrowright: 1 };
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === ' ' && !e.repeat) handleTap();
  if (k === 't' && !e.repeat) handleThrow();
  if (KEY_X[k] !== undefined || ['w', 's', 'arrowup', 'arrowdown'].includes(k) || k === ' ') {
    keys.add(k);
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

function readInput(): { x: number; v: number } {
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
  return { x: kx !== 0 ? clamp(kx, -1, 1) : phone.x, v: crank !== 0 ? crank : phone.v };
}

function sendHaptic(ms: number | number[]): void {
  if (peer) sendMsg(peer, { kind: 'haptic', ms });
}

// ---- State machine -----------------------------------------------------------
// power = 1 is a normal tap cast; a phone throw casts farther, faster and
// with a higher arc.
function startCast(power = 1): void {
  const far = (clamp(S.aim, -1, 1) + 1) / 2; // 0 = near shore, 1 = far out
  const tx = clamp(680 - 550 * far * power, 30, W - 40);
  const ty = WATER_Y + 24 + 120 * (1 - far);
  S.cast = {
    fx: S.bobber.x,
    fy: S.bobber.y,
    tx,
    ty,
    t: 0,
    dur: CAST_TIME / Math.sqrt(power),
    arc: 170 + (power - 1) * 220,
  };
  S.state = 'casting';
  S.stateT = 0;
}

function doCatch(): void {
  const f = S.fish as ActiveFish;
  S.points += f.def.points;
  S.catchCount += 1;
  S.lastName = f.def.name;
  S.fish = null;
  S.state = 'caught';
  S.stateT = 0;
  sendHaptic([60, 90, 60]);
  resultImg.src = f.def.img;
  resultName.textContent = f.def.kind === 'junk' ? `Junk: ${f.def.name}` : f.def.name;
  resultDetail.textContent =
    f.def.kind === 'junk'
      ? `${f.size} ${f.def.sizeUnit} · 0 pts — keep the water clean`
      : `${f.size} ${f.def.sizeUnit} · ${f.def.points} pts`;
  resultOverlay.classList.remove('hidden');
}

function doLose(text: string): void {
  flash(text);
  S.fish = null;
  S.state = 'lost';
  S.stateT = 0;
  sendHaptic(300);
}

function handleThrow(): void {
  // A physical throw of the phone casts with full power — and re-throws the
  // line if it's already in the water.
  if (S.state === 'idle' || S.state === 'waiting') {
    startCast(1.3);
  }
}

function handleTap(): void {
  if (S.state === 'idle') {
    startCast();
  } else if (S.state === 'bite') {
    S.state = 'fight';
    S.stateT = 0;
    S.tension = 0.3;
    S.progress = 0.15;
    S.bursting = false;
    S.burstT = 0.7;
    addRipple(S.bobber.x, S.bobber.y, 34);
  } else if (S.state === 'lost' || S.state === 'caught') {
    resultOverlay.classList.add('hidden');
    S.state = 'idle';
    S.stateT = 0;
  }
}

againBtn.addEventListener('click', handleTap);
canvas.addEventListener('click', () => {
  if (S.state !== 'caught') handleTap();
});

// ---- Update --------------------------------------------------------------------
function update(dt: number): void {
  S.t += dt;
  S.stateT += dt;
  if (S.flash) {
    S.flashT += dt / 1.8;
    if (S.flashT >= 1) S.flash = null;
  }
  for (const r of S.ripples) r.r += 55 * dt;
  S.ripples = S.ripples.filter((r) => r.r < r.max);

  for (const a of S.ambient) {
    a.x += a.dir * a.speed * dt;
    if (a.x < -60) a.x = W + 50;
    if (a.x > W + 60) a.x = -50;
    a.y = a.baseY + Math.sin(S.t * 0.8 + a.phase) * 6;
  }

  const input = readInput();
  S.aim += (input.x - S.aim) * (1 - Math.exp(-dt * 6));
  S.rodAngle += (rodAngleFor(S.aim) - S.rodAngle) * (1 - Math.exp(-dt * 7));

  switch (S.state) {
    case 'idle': {
      const tip = rodTip(S.rodAngle);
      S.bobber.x = tip.x;
      S.bobber.y = tip.y + 66 + Math.sin(S.t * 1.8) * 4;
      S.lineSlack = 0.55;
      S.bobberDip = 0;
      break;
    }
    case 'casting': {
      const c = S.cast as { fx: number; fy: number; tx: number; ty: number; t: number; dur: number; arc: number };
      c.t += dt / c.dur;
      const t = Math.min(1, c.t);
      const cx = (c.fx + c.tx) / 2;
      const cy = (c.fy + c.ty) / 2 - c.arc;
      const u = 1 - t;
      S.bobber.x = u * u * c.fx + 2 * u * t * cx + t * t * c.tx;
      S.bobber.y = u * u * c.fy + 2 * u * t * cy + t * t * c.ty;
      S.lineSlack = 0.2;
      S.bobberDip = 0;
      if (t >= 1) {
        S.bobber = { x: c.tx, y: c.ty };
        S.bobberBase = { x: c.tx, y: c.ty };
        addRipple(c.tx, c.ty, 46);
        S.state = 'waiting';
        S.stateT = 0;
        scheduleBite();
      }
      break;
    }
    case 'waiting': {
      S.biteT -= dt;
      S.bobber.x = S.bobberBase.x;
      S.bobber.y = S.bobberBase.y + Math.sin(S.t * 2.3) * 3;
      S.lineSlack = 0.5;
      S.bobberDip = 0;
      const f = S.fish;
      if (f && S.biteT < 2.2) {
        const dx = S.bobber.x - 10 - f.x;
        const dy = S.bobber.y + 46 - f.y;
        const d = Math.hypot(dx, dy) || 1;
        const step = 75 * dt;
        if (d > step) {
          f.x += (dx / d) * step;
          f.y += (dy / d) * step;
        } else {
          f.x = S.bobber.x - 10;
          f.y = S.bobber.y + 46;
        }
        f.dir = dx >= 0 ? 1 : -1;
      }
      if (S.biteT <= 0) {
        S.state = 'bite';
        S.stateT = 0;
        addRipple(S.bobber.x, S.bobber.y, 30);
        sendHaptic(90);
      }
      break;
    }
    case 'bite': {
      const k = Math.min(1, S.stateT / BITE_WINDOW);
      S.bobberDip = Math.sin(Math.PI * k);
      const f = S.fish;
      if (f) {
        f.x += (S.bobber.x - 12 - f.x) * Math.min(1, dt * 5);
        f.y += (S.bobber.y + 40 - f.y) * Math.min(1, dt * 5);
        f.dir = -1;
      }
      if (S.stateT >= BITE_WINDOW) {
        flash('It got away…');
        S.fish = null;
        S.state = 'waiting';
        S.stateT = 0;
        scheduleBite();
      }
      break;
    }
    case 'fight': {
      const f = S.fish as ActiveFish;
      S.burstT -= dt;
      if (S.burstT <= 0) {
        S.bursting = !S.bursting;
        S.burstT = S.bursting ? 1.1 + Math.random() * 1.5 : 0.6 + Math.random() * 1.2;
        if (S.bursting) {
          addRipple(S.bobber.x, S.bobber.y, 26);
          sendHaptic(70);
        }
      }
      const p = S.bursting
        ? f.def.strength * (0.72 + 0.28 * Math.sin(S.stateT * 9 + f.phase))
        : f.def.strength * 0.12;
      const { v } = readInput();
      const r = clamp(v / MAX_CRANK_RAD_S, 0, 1);
      const lo = clamp(-v / MAX_CRANK_RAD_S, 0, 0.7);
      S.tension = clamp(S.tension + dt * (r * (0.55 + 1.35 * p) - 0.85 - 0.9 * lo), 0, 1);
      S.progress = clamp(
        S.progress + dt * (0.2 * r - 0.24 * p * (1 - 0.7 * r) - 0.13 * lo),
        0,
        1
      );
      S.bobber.x = S.bobberBase.x - (S.bursting ? p * 22 : 0);
      S.bobber.y =
        WATER_Y + 8 + (S.bursting ? 10 + 5 * Math.sin(S.stateT * 13) : 3 * Math.sin(S.stateT * 2.6));
      S.bobberDip = S.bursting ? 0.45 + 0.5 * p : 0.12;
      S.lineSlack = 0.04;
      f.x = S.bobber.x - 44 - p * 24;
      f.y = S.bobber.y + 50 + Math.sin(S.stateT * 7 + f.phase) * 8 * (0.25 + p);
      f.dir = -1;
      if (S.progress >= 1) {
        doCatch();
      } else if (S.tension >= 1) {
        doLose('LINE SNAPPED!');
      } else if (S.progress <= 0) {
        doLose('It got away…');
      }
      break;
    }
    case 'lost': {
      if (S.stateT >= 1.7) {
        S.state = 'idle';
        S.stateT = 0;
      }
      break;
    }
    case 'caught':
      break;
  }
}

// ---- Render ---------------------------------------------------------------------
function sceneView(): Scene {
  const f = S.fish;
  const fishView: FishView | null = f
    ? {
        img: f.def.img,
        x: f.x,
        y: f.y,
        size: f.def.kind === 'junk' ? 44 : 58 + (f.size / f.def.sizeMax) * 42,
        dir: f.dir,
        alpha: 0.92,
        rot: Math.sin(S.t * 6 + f.phase) * 0.18 * (S.state === 'fight' ? 1.7 : 1),
      }
    : null;
  const ambient: FishView[] = S.ambient.map((a) => ({
    img: a.img,
    x: a.x,
    y: a.y,
    size: a.size,
    dir: a.dir,
    alpha: 0.5,
    rot: Math.sin(S.t + a.phase) * 0.07,
  }));
  return {
    t: S.t,
    state: S.state,
    rodAngle: S.rodAngle,
    bobber: { ...S.bobber },
    bobberDip: S.bobberDip,
    lineSlack: S.lineSlack,
    fish: fishView,
    ambient,
    ripples: S.ripples,
    tension: S.tension,
    progress: S.progress,
    points: S.points,
    catchCount: S.catchCount,
    lastName: S.lastName,
    flash: S.flash,
    flashT: S.flash ? Math.min(1, S.flashT) : 0,
  };
}

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;
  update(dt);
  draw(ctx, sceneView());
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---- WebRTC (initiator: computer) --------------------------------------------------
function setStatus(text: string): void {
  statusEl.textContent = text;
}

// Loopback ICE candidates are useless to the remote peer and only bloat the
// SDP that passes through the relay, so drop them before shipping it.
function trimSdp(sdp: string): string {
  return sdp
    .split('\n')
    .filter((line) => !line.startsWith('a=candidate:') || !line.includes(' 127.0.0.1 '))
    .join('\n');
}

// The QR points straight at the controller page carrying just the room code.
// Scanning it opens the right page; the two sides then rendezvous through the
// /api/signal relay to finish the WebRTC handshake with no further input.
function roomUrl(room: string): string {
  return `${location.origin}/controller.html?room=${room}`;
}

// Short, unambiguous room code (no 0/O, 1/I/l) — enough for ephemeral rooms.
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeRoom(): string {
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => ROOM_ALPHABET[n % ROOM_ALPHABET.length]).join('');
}

let room = '';
let pollAbort: AbortController | null = null;

function startSession(): void {
  peer?.destroy();
  peer = null;
  pollAbort?.abort();
  pollAbort = new AbortController();
  room = makeRoom();

  pairQR.classList.add('hidden');
  roomCodeEl.textContent = room;
  linkUrl.value = roomUrl(room);
  qrHint.textContent = 'Generating the QR code…';
  setStatus('Preparing pairing…');

  const p = createLink({
    initiator: true,
    onSignal: (sig) => {
      const s = sig as { type?: string; sdp?: string };
      if (s?.type === 'offer' && s.sdp) {
        void postSignal(room, 'offer', JSON.stringify({ type: s.type, sdp: trimSdp(s.sdp) })).then(
          () => {
            if (statusEl.textContent.startsWith('Preparing')) {
              setStatus('Waiting for the phone to scan…');
            }
          }
        );
      }
    },
    onOpen: () => {
      pollAbort?.abort();
      setStatus('Controller connected. Lean to aim, flick to throw, spin the wheel to crank!');
      pairPanel.classList.add('hidden');
      sendMsg(p, { kind: 'hello' });
      resultOverlay.classList.add('hidden');
      S.fish = null;
      S.state = 'idle';
      S.stateT = 0;
    },
    onData: (m: Msg) => {
      if (m.kind === 'ctrl') {
        phone.x = m.x;
        phone.y = m.y;
        phone.v = m.v;
        phone.frames += 1;
        debugEl.textContent =
          phone.frames + ' frames  x=' + m.x.toFixed(2) + ' y=' + m.y.toFixed(2) +
          ' crank=' + m.v.toFixed(1);
      } else if (m.kind === 'tap') {
        handleTap();
      } else if (m.kind === 'throw') {
        handleThrow();
      } else {
        debugEl.textContent = 'got: ' + m.kind;
      }
    },
    onClose: () => {
      pairPanel.classList.remove('hidden');
      setStatus('Controller disconnected. Use "New code" and pair again.');
    },
    onError: (e) => setStatus('Link error: ' + e.message),
  });
  peer = p;
  if (location.search.includes('debug=1')) (window as Window & { __peer?: unknown }).__peer = p;

  // The QR is just the room URL — tiny and scans instantly.
  void toDataURL(roomUrl(room), { errorCorrectionLevel: 'M', margin: 2, width: 320 })
    .then((dataUrl) => {
      pairQR.src = dataUrl;
      pairQR.classList.remove('hidden');
      qrHint.textContent = 'Scan with your phone — it connects automatically.';
    })
    .catch(() => {
      qrHint.textContent = 'QR unavailable — use the code below or copy the URL.';
    });

  // Poll for the phone's answer, then complete the handshake.
  void waitForSignal(room, 'answer', pollAbort.signal)
    .then((answer) => {
      peer?.signal(JSON.parse(answer));
      setStatus('Connecting…');
    })
    .catch(() => {
      // Aborted by a new session, or the page closed — nothing to do.
    });
}

newSessionBtn.addEventListener('click', startSession);

copyUrlBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(linkUrl.value);
    copyUrlBtn.textContent = 'Copied!';
    setTimeout(() => (copyUrlBtn.textContent = 'Copy URL'), 1500);
  } catch {
    setStatus('Copy failed. Select the URL and copy manually.');
  }
});

spawnAmbient();
  debugEl.textContent = 'A/D aim · W crank · S let out · T throw · Space tap — or pair the phone';

// Auto-start: the QR appears as soon as the page loads.
startSession();
