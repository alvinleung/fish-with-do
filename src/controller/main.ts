import type { Instance as Peer } from 'simple-peer';
import { createLink, sendMsg } from '../shared/link';
import { postSignal, waitForSignal } from '../shared/signal';
import { requestMotionPermission, startTilt } from '../shared/tilt';
import type { Msg } from '../shared/protocol';
import reelBgUrl from '../assets/wheel-spinning-bg.png';
import reelFgUrl from '../assets/wheel-spinning-fg.png';
import './style.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const statusEl = $('status');
const startBtn = $('startBtn') as HTMLButtonElement;
const pairHint = $('pairHint');
const roomCodeEl = $('roomCode');
const readout = $('tiltReadout');
const reelEl = $('reel') as HTMLElement;
const reelBgEl = $('reelBg') as HTMLImageElement;
const reelFgEl = $('reelFg') as HTMLImageElement;

reelBgEl.src = reelBgUrl;
reelFgEl.src = reelFgUrl;

let peer: Peer | null = null;
let connected = false;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

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

// ---- Reel display ---------------------------------------------------------------
// The wheel's foreground spins with your wrist twist, exactly like cranking a
// reel handle. Every 30° of rotation is one ratchet notch.
const NOTCH = Math.PI / 6;
const latest = { x: 0, y: 0, v: 0 };
let crankAngle = 0;
let prevNotch = 0;
let lastNow = performance.now();

function reelLoop(now: number): void {
  const dt = Math.min(0.05, (now - lastNow) / 1000);
  lastNow = now;
  crankAngle += latest.v * dt;
  reelFgEl.style.transform = `rotate(${((crankAngle * 180) / Math.PI) % 360}deg)`;
  const notch = Math.floor(crankAngle / NOTCH);
  if (notch !== prevNotch) {
    prevNotch = notch;
    if (Math.abs(latest.v) > 0.3) {
      buzz(12);
      ratchetClick();
    }
  }
  requestAnimationFrame(reelLoop);
}
requestAnimationFrame(reelLoop);

// Tap the wheel = cast / strike / continue.
reelEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  buzz(10);
  if (connected && peer) sendMsg(peer, { kind: 'tap' });
  reelEl.classList.remove('tapped');
  void reelEl.offsetWidth;
  reelEl.classList.add('tapped');
});

// ---- Motion -------------------------------------------------------------------
// iOS needs an explicit user gesture to unlock the orientation sensor, so the
// button both requests permission, unlocks audio, and starts streaming.
startBtn.addEventListener('click', async () => {
  ensureAudio();
  const granted = await requestMotionPermission();
  if (!granted) {
    setStatus('Motion permission was not granted.');
    return;
  }
  startTilt((s) => {
    latest.x = s.x;
    latest.y = s.y;
    latest.v = (s.twist * Math.PI) / 180; // deg/s -> rad/s
    if (connected && peer) sendMsg(peer, { kind: 'ctrl', x: s.x, y: s.y, v: latest.v });
    readout.textContent = `x ${s.x.toFixed(2)}  y ${s.y.toFixed(2)}  crank ${latest.v.toFixed(1)} rad/s`;
  });
  startBtn.disabled = true;
  startBtn.textContent = 'Motion enabled';
  setStatus('Ready — you are the reel.');
});

// ---- WebRTC (responder: phone) ---------------------------------------------------
// Drop loopback ICE candidates before shipping the answer through the relay.
function trimSdp(sdp: string): string {
  return sdp
    .split('\n')
    .filter((line) => !line.startsWith('a=candidate:') || !line.includes(' 127.0.0.1 '))
    .join('\n');
}

function applyRoom(roomCode: string): void {
  roomCodeEl.textContent = roomCode;
  setStatus('Waiting for the game…');
  pairHint.textContent = 'Listening for the game… it sends the offer automatically.';

  peer = createLink({
    initiator: false,
    onSignal: (sig) => {
      const s = sig as { type?: string; sdp?: string };
      if (s?.type === 'answer' && s.sdp) {
        void postSignal(roomCode, 'answer', JSON.stringify({ type: s.type, sdp: trimSdp(s.sdp) }));
      }
    },
    onOpen: () => {
      connected = true;
      setStatus('Connected. Tilt to aim, twist to crank!');
      pairHint.textContent = 'Linked with the game.';
    },
    onData: (m: Msg) => {
      if (m.kind === 'haptic') {
        buzz(m.ms);
      } else if (m.kind === 'hello') {
        setStatus('Connected. You are the reel!');
      }
    },
    onClose: () => {
      connected = false;
      setStatus('Disconnected from the game.');
    },
    onError: (e) => setStatus('Link error: ' + e.message),
  });
  if (location.search.includes('debug=1')) (window as Window & { __peer?: unknown }).__peer = peer;

  // Poll the relay for the game's offer. Once it arrives we answer, and the
  // onSignal handler above ships the answer back — completing the handshake
  // with no copy/paste.
  void waitForSignal(roomCode, 'offer')
    .then((offer) => {
      peer?.signal(JSON.parse(offer));
      setStatus('Answering…');
    })
    .catch((e) => {
      setStatus('Could not reach the relay: ' + (e as Error).message);
    });
}

const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  applyRoom(roomParam.toUpperCase());
} else {
  pairHint.textContent = 'This page was opened without a room code.';
  setStatus('Scan the QR on the computer screen — it opens this page for you.');
}
