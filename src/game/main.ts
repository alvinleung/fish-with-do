import Matter from 'matter-js';
import { toDataURL } from 'qrcode';
import type { Instance as Peer } from 'simple-peer';
import { createLink, sendMsg } from '../shared/link';
import { postSignal, waitForSignal } from '../shared/signal';
import type { Msg } from '../shared/protocol';
import {
  CANVAS_W,
  CANVAS_H,
  BALL_R,
  GOAL_R,
  START,
  GOAL,
  WALLS,
} from './maze';
import './style.css';

const { Engine, Bodies, Composite, Body, Events } = Matter;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const canvas = $('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const statusEl = $('status');
const tiltDebug = $('tiltDebug');
const newSessionBtn = $('newSessionBtn') as HTMLButtonElement;
const pairPanel = $('pair');
const pairQR = $('pairQR') as HTMLImageElement;
const roomCodeEl = $('roomCode');
const qrHint = $('qrHint');
const linkUrl = $('linkUrl') as HTMLInputElement;
const copyUrlBtn = $('copyUrlBtn') as HTMLButtonElement;
const winOverlay = $('winOverlay');
const winTimeEl = $('winTime');
const againBtn = $('againBtn') as HTMLButtonElement;

canvas.width = CANVAS_W;
canvas.height = CANVAS_H;

// Tilt -> gravity mapping. Flip INVERT_X / INVERT_Y if the ball feels
// backwards, or tune GRAVITY_SCALE for more/less responsiveness.
const GRAVITY_SCALE = 1.4;
const INVERT_X = false;
const INVERT_Y = true;

// ---- Physics ---------------------------------------------------------------
const engine = Engine.create();
const walls = WALLS.map((w) =>
  Bodies.rectangle(w.x + w.w / 2, w.y + w.h / 2, w.w, w.h, { isStatic: true })
);
const ball = Bodies.circle(START.x, START.y, BALL_R, {
  restitution: 0.2,
  friction: 0.001,
  frictionAir: 0.012,
  label: 'ball',
});
const goal = Bodies.circle(GOAL.x, GOAL.y, GOAL_R, {
  isStatic: true,
  isSensor: true,
  label: 'goal',
});
Composite.add(engine.world, [...walls, ball, goal]);

let latest = { x: 0, y: 0 };
let won = false;
let startTime = performance.now();
let peer: Peer | null = null;

Events.on(engine, 'collisionStart', (ev) => {
  if (won) return;
  for (const pair of ev.pairs) {
    if (pair.bodyA.label === 'goal' || pair.bodyB.label === 'goal') {
      won = true;
      const ms = performance.now() - startTime;
      winTimeEl.textContent = (ms / 1000).toFixed(1) + ' s';
      winOverlay.classList.remove('hidden');
      if (peer) sendMsg(peer, { kind: 'win', time: ms });
      break;
    }
  }
});

function resetBall(): void {
  Body.setPosition(ball, { x: START.x, y: START.y });
  Body.setVelocity(ball, { x: 0, y: 0 });
  Body.setAngularVelocity(ball, 0);
  won = false;
  startTime = performance.now();
  winOverlay.classList.add('hidden');
}

againBtn.addEventListener('click', resetBall);

// ---- Render + update loop --------------------------------------------------
function draw(): void {
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
  ctx.beginPath();
  ctx.arc(GOAL.x, GOAL.y, GOAL_R, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(34,197,94,' + (0.45 + 0.55 * pulse).toFixed(3) + ')';
  ctx.fill();

  ctx.fillStyle = '#334155';
  for (const w of walls) {
    ctx.fillRect(
      w.bounds.min.x,
      w.bounds.min.y,
      w.bounds.max.x - w.bounds.min.x,
      w.bounds.max.y - w.bounds.min.y
    );
  }

  ctx.beginPath();
  ctx.arc(ball.position.x, ball.position.y, BALL_R, 0, Math.PI * 2);
  ctx.fillStyle = won ? '#22c55e' : '#f59e0b';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#0b1220';
  ctx.stroke();
}

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(32, now - last);
  last = now;
  if (!won) {
    engine.gravity.x = latest.x * (INVERT_X ? -1 : 1) * GRAVITY_SCALE;
    engine.gravity.y = latest.y * (INVERT_Y ? -1 : 1) * GRAVITY_SCALE;
    Engine.update(engine, dt);
  }
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---- WebRTC (initiator: computer) -----------------------------------------
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
        // Ship the full signal object as JSON; the phone JSON.parses it and
        // hands the {type, sdp} object to simple-peer's signal().
        void postSignal(room, 'offer', JSON.stringify({ type: s.type, sdp: trimSdp(s.sdp) })).then(() => {
          if (statusEl.textContent.startsWith('Preparing')) {
            setStatus('Waiting for the phone to scan…');
          }
        });
      }
    },
    onOpen: () => {
      pollAbort?.abort();
      setStatus('Controller connected. Tilt to steer!');
      pairPanel.classList.add('hidden');
      sendMsg(p, { kind: 'hello' });
      resetBall();
    },
    onData: (m: Msg) => {
      if (m.kind === 'tilt') {
        latest = { x: m.x, y: m.y };
        tiltDebug.textContent =
          'recv ' + m.x.toFixed(2) + ', ' + m.y.toFixed(2);
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

// Auto-start: the QR appears as soon as the page loads.
startSession();
