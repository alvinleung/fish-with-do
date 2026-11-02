import type { Instance as Peer } from 'simple-peer';
import { createLink, sendMsg, fetchRtcConfig } from '../shared/link';
import { postSignal, waitForSignal } from '../shared/signal';
import { requestMotionPermission, startTilt } from '../shared/tilt';
import { startThrowDetection } from '../shared/throw';
import type { Msg } from '../shared/protocol';
import reelBgUrl from '../assets/wheel-spinning-bg.png';
import reelFgUrl from '../assets/wheel-spinning-fg.png';
import './style.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const permBtn = $('permBtn') as HTMLButtonElement;
const permNote = $('permNote');
const perm = $('perm');
const wheelView = $('wheelView');
const statusEl = $('status');
const reelEl = $('reel') as HTMLElement;
const reelBgEl = $('reelBg') as HTMLImageElement;
const reelFgEl = $('reelFg') as HTMLImageElement;

reelBgEl.src = reelBgUrl;
reelFgEl.src = reelFgUrl;

let peer: Peer | null = null;
// Two separate gates: motion must be granted (the user settled the permission)
// AND the WebRTC link must be open. Until both, the phone is "not connected"
// and sends no input to the game.
let motionGranted = false;
let connected = false;
const roomCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase();

// ---- Haptics + ratchet sound --------------------------------------------------
// iPhones cannot vibrate from the web (Safari has no Vibration API), so every
// ratchet notch also plays a short mechanical click; on Android you get both.
function buzz(ms: number | number[]): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // unsupported — the click sound still conveys the ratchet
  }
}

let actx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

// Must be called from a user gesture (iOS unlocks audio only then).
function ensureAudio(): void {
  if (actx) {
    if (actx.state === 'suspended') void actx.resume();
    return;
  }
  const AC =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  actx = new AC();
  const len = Math.floor(actx.sampleRate * 0.05);
  noise = actx.createBuffer(1, len, actx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
}

function ratchetClick(): void {
  if (!actx || !noise || actx.state !== 'running') return;
  const t = actx.currentTime;
  const src = actx.createBufferSource();
  src.buffer = noise;
  const f = actx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 2400;
  f.Q.value = 1.1;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.4, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
  src.connect(f);
  f.connect(g);
  g.connect(actx.destination);
  src.start(t, Math.random() * 0.03, 0.05);
}

// ---- Reel display + finger crank ------------------------------------------------
// Cranking is a rotary touch gesture: hold the wheel and circle your finger —
// the foreground follows the finger exactly. Every 30° of rotation is one
// ratchet notch (haptic tick + click). A quick, still touch is a tap
// (cast / strike / continue).
const NOTCH = Math.PI / 6;
const TAP_MAX_PX = 12;
const TAP_MAX_MS = 300;

const latest = { x: 0, y: 0, v: 0 };
let crankAngle = 0;
let prevNotch = 0;
let lastNow = performance.now();

let activePointer: number | null = null;
let lastAngle: number | null = null;
let lastMoveAt = 0;
let downX = 0;
let downY = 0;
let downAt = 0;
let movedPx = 0;
let cranking = false;
let fingerVel = 0;

function pointerAngle(e: PointerEvent): number {
  const rect = reelEl.getBoundingClientRect();
  return Math.atan2(
    e.clientY - (rect.top + rect.height / 2),
    e.clientX - (rect.left + rect.width / 2)
  );
}

function reelLoop(now: number): void {
  const dt = Math.min(0.05, (now - lastNow) / 1000);
  lastNow = now;
  if (!cranking) {
    // brief inertia after the finger lets go, then stop
    fingerVel *= Math.exp(-dt * 10);
    if (Math.abs(fingerVel) < 0.05) fingerVel = 0;
    crankAngle += fingerVel * dt;
  }
  latest.v = fingerVel;
  reelFgEl.style.transform = `rotate(${((crankAngle * 180) / Math.PI) % 360}deg)`;
  const notch = Math.floor(crankAngle / NOTCH);
  if (notch !== prevNotch) {
    prevNotch = notch;
    if (Math.abs(fingerVel) > 0.3) {
      buzz(12);
      ratchetClick();
    }
  }
  requestAnimationFrame(reelLoop);
}
requestAnimationFrame(reelLoop);

reelEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  reelEl.setPointerCapture(e.pointerId);
  activePointer = e.pointerId;
  lastAngle = pointerAngle(e);
  lastMoveAt = performance.now();
  downX = e.clientX;
  downY = e.clientY;
  downAt = lastMoveAt;
  movedPx = 0;
  cranking = false;
  fingerVel = 0;
});

reelEl.addEventListener('pointermove', (e) => {
  if (e.pointerId !== activePointer || lastAngle === null) return;
  movedPx += Math.hypot(e.clientX - downX, e.clientY - downY);
  const a = pointerAngle(e);
  let d = a - lastAngle;
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  if (movedPx > TAP_MAX_PX) cranking = true;
  if (cranking) {
    const now = performance.now();
    const dt = Math.max(0.008, (now - lastMoveAt) / 1000);
    fingerVel = fingerVel * 0.5 + (d / dt) * 0.5;
    crankAngle += d;
  }
  lastAngle = a;
  lastMoveAt = performance.now();
});

function endPointer(e: PointerEvent): void {
  if (e.pointerId !== activePointer) return;
  const dur = performance.now() - downAt;
  if (!cranking && dur < TAP_MAX_MS) {
    buzz(10);
    if (motionGranted && connected && peer) sendMsg(peer, { kind: 'tap' });
    reelEl.classList.remove('tapped');
    void reelEl.offsetWidth;
    reelEl.classList.add('tapped');
  }
  activePointer = null;
  lastAngle = null;
  cranking = false;
}

reelEl.addEventListener('pointerup', endPointer);
reelEl.addEventListener('pointercancel', endPointer);

// ---- Motion + connection -------------------------------------------------------
// Flow: land on the permission prompt -> grant motion -> only then connect and
// reveal the wheel. Motion is a hard gate: until it's settled we never
// establish the link, so the phone is not considered connected.
permBtn.addEventListener('click', async () => {
  ensureAudio();
  const granted = await requestMotionPermission();
  if (!granted) {
    permNote.textContent =
      'Motion access is required to aim the rod. Allow it in your browser settings, then tap again.';
    return;
  }
  motionGranted = true;
  perm.classList.add('hidden');
  wheelView.classList.remove('hidden');
  startTilt((s) => {
    latest.x = s.x;
    latest.y = s.y;
    if (motionGranted && connected && peer) {
      sendMsg(peer, { kind: 'ctrl', x: s.x, y: s.y, v: latest.v });
    }
  });
  startThrowDetection(() => {
    buzz(40);
    ratchetClick();
    if (motionGranted && connected && peer) sendMsg(peer, { kind: 'throw' });
  });
  void connect();
});

// Drop loopback ICE candidates before shipping the answer through the relay.
function trimSdp(sdp: string): string {
  return sdp
    .split('\n')
    .filter((line) => !line.startsWith('a=candidate:') || !line.includes(' 127.0.0.1 '))
    .join('\n');
}

async function connect(): Promise<void> {
  const config = await fetchRtcConfig();
  peer = createLink({
    initiator: false,
    config,
    onSignal: (sig) => {
      const s = sig as { type?: string; sdp?: string };
      if (s?.type === 'answer' && s.sdp) {
        void postSignal(roomCode, 'answer', JSON.stringify({ type: s.type, sdp: trimSdp(s.sdp) }));
      }
    },
    onOpen: () => {
      connected = true;
    },
    onData: (m: Msg) => {
      if (m.kind === 'haptic') buzz(m.ms);
    },
    onClose: () => {
      connected = false;
    },
  });
  if (location.search.includes('debug=1')) (window as Window & { __peer?: unknown }).__peer = peer;

  // Poll the relay for the game's offer. The game posts it with a 300s TTL, so
  // starting this only after the user grants motion permission is safe.
  void waitForSignal(roomCode, 'offer')
    .then((offer) => {
      peer?.signal(JSON.parse(offer));
    })
    .catch(() => {
      // aborted or the offer hasn't arrived yet — the poll loop keeps trying.
    });
}

// Opened without a room code: there's nothing to connect to, so swap the
// permission prompt for a short explainer.
if (!roomCode) {
  perm.classList.add('hidden');
  statusEl.textContent =
    'Open this page by scanning the QR on the computer screen — it carries the room code.';
  statusEl.classList.remove('hidden');
}
