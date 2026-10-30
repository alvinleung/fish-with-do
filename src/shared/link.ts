import SimplePeer from 'simple-peer';
import type { Instance as PeerInstance } from 'simple-peer';
import type { Msg } from './protocol';

export type LinkOptions = {
  // true = this side generates the offer (computer/game).
  // false = this side answers (phone/controller).
  initiator: boolean;
  onSignal?: (signal: unknown) => void;
  onOpen?: () => void;
  onData?: (data: Msg) => void;
  // Fired only when a received frame could not be decoded into a {kind,...}
  // message. Useful for diagnosing unexpected wire types.
  onRawData?: (raw: unknown) => void;
  onClose?: () => void;
  onError?: (err: Error) => void;
};

// STUN lets each device learn its public address so pairing works even when the
// phone is on cellular and the computer is on Wi‑Fi. It only helps ICE find the
// path — it sees no game data, which stays peer‑to‑peer. Host candidates still
// let same‑LAN / phone‑hotspot pairing connect instantly.
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// simple-peer emits its "signal" (offer/answer) from a snapshot of
// localDescription that can be taken before ICE candidates are flushed in,
// which would ship a QR / payload with no candidates and silently fail to
// connect. Re-read the SDP once gathering has completed so the emitted blob
// always carries every candidate. Falls back to the original SDP if we can't
// observe the underlying RTCPeerConnection.
function finalizedSdp(peer: PeerInstance, fallback: string): Promise<string> {
  const pc = (peer as unknown as { _pc?: RTCPeerConnection })._pc;
  if (!pc || !pc.localDescription) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve(pc.localDescription?.sdp || fallback);
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, 2500); // never block pairing forever
    if (pc.iceGatheringState === 'complete') {
      finish();
      return;
    }
    pc.addEventListener('icegatheringstatechange', check);
    check();
  });
}

// Tilt frames are JSON, but a WebRTC data channel can hand them back as a text
// string or as binary (ArrayBuffer / typed array / Blob) depending on the
// browser and simple-peer's binaryType. Decode every possible shape so the app
// always receives a real {kind,...} object.
async function toText(d: unknown): Promise<string | null> {
  if (typeof d === 'string') return d;
  if (typeof ArrayBuffer !== 'undefined' && d instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(d));
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(d)) {
    return new TextDecoder().decode(d as ArrayBufferView);
  }
  if (typeof Blob !== 'undefined' && d instanceof Blob) {
    return (d as Blob).text();
  }
  return null;
}

async function decodeFrame(d: unknown): Promise<Msg | null> {
  const text = await toText(d);
  if (text === null) return null;
  try {
    const o = JSON.parse(text) as Msg;
    if (o && typeof o === 'object' && typeof o.kind === 'string') return o;
  } catch {
    // not JSON — fall through to null
  }
  return null;
}

// Creates a WebRTC peer with a single data channel. With trickle:false each
// side emits exactly one "signal" (offer or answer) carrying all ICE
// candidates inline, which is what makes QR / copy-paste pairing possible
// with no signaling server.
export function createLink(opts: LinkOptions): PeerInstance {
  const peer = new SimplePeer({
    initiator: opts.initiator,
    trickle: false,
    config: RTC_CONFIG,
  });

  peer.on('signal', (sig: unknown) => {
    const s = sig as { type?: string; sdp?: string };
    if (s && typeof s.sdp === 'string') {
      void finalizedSdp(peer, s.sdp).then((sdp) =>
        opts.onSignal?.({ type: s.type, sdp })
      );
    } else {
      opts.onSignal?.(sig);
    }
  });
  // simple-peer's "we are connected" event is 'connect' (not 'open').
  peer.on('connect', () => opts.onOpen?.());
  peer.on('data', (d: unknown) => {
    void decodeFrame(d).then((msg) => {
      if (msg) opts.onData?.(msg);
      else opts.onRawData?.(d);
    });
  });
  peer.on('close', () => opts.onClose?.());
  peer.on('error', (e: unknown) => opts.onError?.(e as Error));
  return peer;
}

export function sendMsg(peer: PeerInstance, msg: Msg): void {
  if (peer.connected) peer.send(JSON.stringify(msg));
}
