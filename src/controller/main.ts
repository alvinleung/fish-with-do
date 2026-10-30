import type { Instance as Peer } from 'simple-peer';
import { createLink, sendMsg } from '../shared/link';
import { postSignal, waitForSignal } from '../shared/signal';
import { requestMotionPermission, startTilt } from '../shared/tilt';
import type { Msg } from '../shared/protocol';
import './style.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const statusEl = $('status');
const startBtn = $('startBtn') as HTMLButtonElement;
const pairHint = $('pairHint');
const roomCodeEl = $('roomCode');
const tiltReadout = $('tiltReadout');

let peer: Peer | null = null;
let connected = false;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

// ---- Motion -----------------------------------------------------------------
// iOS needs an explicit user gesture to unlock the orientation sensor, so the
// button both requests permission and starts streaming tilt.
startBtn.addEventListener('click', async () => {
  const granted = await requestMotionPermission();
  if (!granted) {
    setStatus('Motion permission was not granted.');
    return;
  }
  startTilt((v) => {
    if (connected && peer) sendMsg(peer, { kind: 'tilt', x: v.x, y: v.y });
    tiltReadout.textContent =
      `x ${v.x.toFixed(2)}   y ${v.y.toFixed(2)}` +
      (connected ? '' : '   (not connected yet — values still updating)');
  });
  startBtn.disabled = true;
  startBtn.textContent = 'Motion enabled';
});

// ---- WebRTC (responder: phone) ---------------------------------------------
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
        // Mirror of the game's offer: ship {type, sdp} as JSON so the game can
        // JSON.parse it and hand the object to simple-peer's signal().
        void postSignal(roomCode, 'answer', JSON.stringify({ type: s.type, sdp: trimSdp(s.sdp) }));
      }
    },
    onOpen: () => {
      connected = true;
      setStatus('Connected. Tilt to steer!');
      pairHint.textContent = 'Linked with the game.';
    },
    onData: (m: Msg) => {
      if (m.kind === 'win') navigator.vibrate?.(180);
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
