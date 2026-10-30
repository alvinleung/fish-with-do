// Browser client for the signaling relay at /api/signal.
//
// The relay is the return path for the WebRTC handshake: the computer posts
// its offer, the phone posts its answer, and each side polls until it has the
// other's SDP. On Vercel this is a serverless function backed by KV; locally a
// vite middleware mock serves the same API.

export type SignalKind = 'offer' | 'answer';

const POLL_MS = 500;

function endpoint(kind: SignalKind, room: string): string {
  return `/api/signal?room=${encodeURIComponent(room)}&kind=${kind}`;
}

// Hand our SDP to the relay so the remote peer can pick it up.
export async function postSignal(room: string, kind: SignalKind, sdp: string): Promise<void> {
  await fetch('/api/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, kind, sdp }),
  });
}

// Poll the relay until the remote peer has posted `kind` for `room`, then
// resolve with its SDP. Pass an AbortSignal to stop polling (e.g. when the
// session is torn down). Rejects if aborted.
export function waitForSignal(
  room: string,
  kind: SignalKind,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    let stopped = false;
    const onAbort = () => {
      stopped = true;
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const res = await fetch(endpoint(kind, room), { signal });
        const body = (await res.json()) as { found?: boolean; sdp?: string | null };
        if (body.found && body.sdp) {
          stopped = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(body.sdp);
          return;
        }
      } catch {
        if (stopped) return; // aborted mid-flight
      }
      if (!stopped) setTimeout(tick, POLL_MS);
    };
    void tick();
  });
}
