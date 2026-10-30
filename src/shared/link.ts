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
  onClose?: () => void;
  onError?: (err: Error) => void;
};

// "Same place" use case: rely on host candidates so the two devices on the
// same LAN / phone hotspot connect instantly and the QR stays compact.
// To work across different networks, add a STUN server here, e.g.
//   { urls: 'stun:stun.l.google.com:19302' }
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [],
};

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

  peer.on('signal', (sig: unknown) => opts.onSignal?.(sig));
  peer.on('open', () => opts.onOpen?.());
  peer.on('data', (d: unknown) => {
    try {
      const msg = (typeof d === 'string' ? JSON.parse(d) : d) as Msg;
      opts.onData?.(msg);
    } catch {
      // ignore non-JSON payloads
    }
  });
  peer.on('close', () => opts.onClose?.());
  peer.on('error', (e: unknown) => opts.onError?.(e as Error));
  return peer;
}

export function sendMsg(peer: PeerInstance, msg: Msg): void {
  if (peer.connected) peer.send(JSON.stringify(msg));
}
