import { kv } from '@vercel/kv';

// Tiny WebRTC signaling relay. The computer posts its offer, the phone posts
// its answer, and each side polls for the other's message. Vercel serverless
// functions are stateless and can run on many instances, so the pending SDP is
// kept in Vercel KV (Redis) — a shared store — instead of in memory.
//
// Locally (vite dev/preview) a mock relay at /api/signal stands in for this,
// so no KV is needed to develop or test.

const TTL_SECONDS = 300; // a pairing attempt should be well under this

type Kind = 'offer' | 'answer';
const isKind = (k: unknown): k is Kind => k === 'offer' || k === 'answer';
const key = (room: string, kind: Kind) => `signal:${room}:${kind}`;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return json(null, 204);

  try {
    if (req.method === 'POST') {
      const body = (await req.json()) as {
        room?: unknown;
        kind?: unknown;
        sdp?: unknown;
      };
      const { room, kind, sdp } = body;
      if (typeof room !== 'string' || !room || !isKind(kind) || typeof sdp !== 'string') {
        return json({ error: 'expected { room, kind: offer|answer, sdp }' }, 400);
      }
      await kv.set(key(room, kind), sdp, { expirationTtl: TTL_SECONDS });
      return json({ ok: true });
    }

    if (req.method === 'GET') {
      const url = new URL(req.url);
      const room = url.searchParams.get('room');
      const kind = url.searchParams.get('kind');
      if (!room || !isKind(kind)) return json({ error: 'expected ?room=...&kind=offer|answer' }, 400);
      const sdp = await kv.get<string>(key(room, kind));
      return json({ found: !!sdp, sdp: sdp ?? null });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
