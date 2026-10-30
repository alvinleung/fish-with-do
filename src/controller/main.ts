import { toDataURL } from 'qrcode';
import jsQR from 'jsqr';
import type { Instance as Peer } from 'simple-peer';
import { createLink, sendMsg } from '../shared/link';
import { requestMotionPermission, startTilt } from '../shared/tilt';
import type { Msg } from '../shared/protocol';
import './style.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const statusEl = $('status');
const startBtn = $('startBtn') as HTMLButtonElement;
const pairPanel = $('pair');
const scanBtn = $('scanBtn') as HTMLButtonElement;
const cam = $('cam') as HTMLVideoElement;
const stopCamBtn = $('stopCamBtn') as HTMLButtonElement;
const offerPaste = $('offerPaste') as HTMLTextAreaElement;
const pasteOfferBtn = $('pasteOfferBtn') as HTMLButtonElement;
const answerWrap = $('answerWrap');
const answerBox = $('answerBox') as HTMLTextAreaElement;
const copyAnswerBtn = $('copyAnswerBtn') as HTMLButtonElement;
const answerQR = $('answerQR') as HTMLImageElement;

let peer: Peer | null = null;
let connected = false;
let cameraStream: MediaStream | null = null;
let scanning = false;

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
  pairPanel.classList.remove('hidden');
  setStatus('Motion ready. Scan the game QR to pair.');
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

async function showAnswer(answer: unknown): Promise<void> {
  const text = JSON.stringify(answer);
  answerBox.value = text;
  answerWrap.classList.remove('hidden');
  setStatus('Got the answer. Copy it and paste it into the computer.');
  try {
    const url = await toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
    answerQR.src = url;
    answerQR.classList.remove('hidden');
  } catch {
    // QR is optional; copy-paste still works.
  }
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

// ---- Offer: scan QR or paste ------------------------------------------------
function applyOffer(offer: unknown): void {
  const p = ensurePeer();
  try {
    p.signal(offer as Parameters<Peer['signal']>[0]);
    setStatus('Offer received. Wait for the answer, then send it to the computer.');
  } catch (e) {
    setStatus('Bad offer: ' + (e as Error).message);
  }
}

pasteOfferBtn.addEventListener('click', () => {
  try {
    applyOffer(JSON.parse(offerPaste.value));
  } catch {
    setStatus('Could not parse the pasted offer. Check the JSON.');
  }
});

async function startCamera(): Promise<void> {
  if (scanning) return;
  scanning = true;
  cam.classList.remove('hidden');
  stopCamBtn.classList.remove('hidden');
  scanBtn.textContent = 'Scanning...';
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    cam.srcObject = cameraStream;
    await cam.play();
  } catch {
    stopCamera();
    setStatus('Camera unavailable. Use "Paste the offer" instead.');
    return;
  }
  scanLoop();
}

function scanLoop(): void {
  if (!scanning) return;
  const w = cam.videoWidth;
  const h = cam.videoHeight;
  if (w > 0 && h > 0) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    if (cx) {
      cx.drawImage(cam, 0, 0, w, h);
      const img = cx.getImageData(0, 0, w, h);
      const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        stopCamera();
        try {
          applyOffer(JSON.parse(code.data));
          return;
        } catch {
          setStatus('Scanned something that is not the offer. Try again.');
        }
      }
    }
  }
  requestAnimationFrame(scanLoop);
}

function stopCamera(): void {
  scanning = false;
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  cam.classList.add('hidden');
  stopCamBtn.classList.add('hidden');
  scanBtn.textContent = 'Scan offer QR';
}

scanBtn.addEventListener('click', () => {
  if (scanning) {
    stopCamera();
  } else {
    void startCamera();
  }
});
stopCamBtn.addEventListener('click', stopCamera);
