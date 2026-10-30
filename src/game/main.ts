import Matter from 'matter-js';
import { toDataURL } from 'qrcode';
import type { Instance as Peer } from 'simple-peer';
import { createLink, sendMsg } from '../shared/link';
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
const newSessionBtn = $('newSessionBtn') as HTMLButtonElement;
const offerWrap = $('offerWrap');
const offerQR = $('offerQR') as HTMLImageElement;
const offerBox = $('offerBox') as HTMLTextAreaElement;
const copyOfferBtn = $('copyOfferBtn') as HTMLButtonElement;
const answerBox = $('answerBox') as HTMLTextAreaElement;
const connectBtn = $('connectBtn') as HTMLButtonElement;
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

newSessionBtn.addEventListener('click', () => {
  peer?.destroy();
  offerWrap.classList.add('hidden');
  setStatus('Generating QR...');
  const p = createLink({
    initiator: true,
    onSignal: (offer) => void renderOffer(offer),
    onOpen: () => {
      setStatus('Controller connected. Tilt to steer!');
      sendMsg(p, { kind: 'hello' });
      resetBall();
    },
    onData: (m: Msg) => {
      if (m.kind === 'tilt') latest = { x: m.x, y: m.y };
    },
    onClose: () => setStatus('Controller disconnected.'),
    onError: (e) => setStatus('Link error: ' + e.message),
  });
  peer = p;
});

async function renderOffer(offer: unknown): Promise<void> {
  const text = JSON.stringify(offer);
  offerBox.value = text;
  offerWrap.classList.remove('hidden');
  setStatus('Show this QR to the phone (or copy the offer).');
  try {
    const url = await toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 480,
    });
    offerQR.src = url;
  } catch {
    setStatus('Could not render the QR. Copy the offer instead.');
  }
}

copyOfferBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(offerBox.value);
    copyOfferBtn.textContent = 'Copied!';
    setTimeout(() => (copyOfferBtn.textContent = 'Copy offer'), 1500);
  } catch {
    setStatus('Copy failed. Select the text and copy manually.');
  }
});

connectBtn.addEventListener('click', () => {
  if (!peer) {
    setStatus('Click "New session" first.');
    return;
  }
  try {
    peer.signal(JSON.parse(answerBox.value));
    setStatus('Waiting for the connection to open...');
  } catch {
    setStatus('Could not parse the answer. Check the JSON.');
  }
});
