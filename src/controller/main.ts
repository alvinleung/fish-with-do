import type { Instance as Peer } from 'simple-peer';
import { createLink, sendMsg } from '../shared/link';
import { requestMotionPermission, startTilt } from '../shared/tilt';
import type { Msg } from '../shared/protocol';
import './style.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const statusEl = $('status');
const startBtn = $('startBtn') as HTMLButtonElement;
const pairHint = $('pairHint');
const answerWrap = $('answerWrap');
const answerBox = $('answerBox') as HTMLTextAreaElement;
const copyAnswerBtn = $('copyAnswerBtn') as HTMLButtonElement;

let peer: Peer | null = null;
let connected = false;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

// ---- Motion -----------------------------------------------------------------
startBtn.addEventListener('click', async () => {
  const granted = await requestMotionPermission();
  if (!granted) {
    setStatus('Motion permission was not granted.');
    return;
  }
  startTilt((v) => {
    if (connected && peer) sendMsg(peer, { kind: 'tilt', x: v.x, y: v.y });
  });
  startBtn.disabled = true;
  startBtn.textContent = 'Motion enabled';
});

// ---- WebRTC (responder: phone) ---------------------------------------------
function ensurePeer(): Peer {
  if (peer) return peer;
  peer = createLink({
    initiator: false,
    onSignal: (answer) => showAnswer(answer),
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
  return peer;
}

function showAnswer(answer: unknown): void {
  answerBox.value = JSON.stringify(answer);
  answerWrap.classList.remove('hidden');
  setStatus('Copy the answer and paste it into the computer to connect.');
}

copyAnswerBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(answerBox.value);
    copyAnswerBtn.textContent = 'Copied!';
    setTimeout(() => (copyAnswerBtn.textContent = 'Copy answer'), 1500);
  } catch {
    setStatus('Copy failed. Select the text and copy manually.');
  }
});

// ---- Offer: read from the URL the game's QR points at -----------------------
function applyOffer(offer: unknown): void {
  const p = ensurePeer();
  try {
    p.signal(offer as Parameters<Peer['signal']>[0]);
    pairHint.textContent =
      'Offer received from the link. Your answer is being prepared…';
  } catch (e) {
    pairHint.textContent = 'The offer in the link could not be used.';
    setStatus('Bad offer: ' + (e as Error).message);
  }
}

const offerParam = new URLSearchParams(location.search).get('offer');
if (offerParam) {
  try {
    applyOffer(JSON.parse(offerParam));
  } catch {
    pairHint.textContent = 'The offer in the link is malformed.';
    setStatus('This link is broken. Re-scan the QR on the computer.');
  }
} else {
  pairHint.textContent = 'This page was opened without a pairing link.';
  setStatus('Scan the QR on the computer screen — it opens this page for you.');
}
