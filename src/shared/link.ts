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
