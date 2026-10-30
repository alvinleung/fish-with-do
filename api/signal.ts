import Redis from 'ioredis';

// Tiny WebRTC signaling relay. The computer posts its offer, the phone posts
// its answer, and each side polls for the other's message. Vercel serverless
// functions are stateless and can run on many instances, so the pending SDP is
// kept in the project's Redis store (fish-with-do-kv, exposed as REDIS_URL) —
// a shared store — instead of in memory.
//
// Locally (vite dev/preview) a mock relay at /api/signal stands in for this,
// so no Redis is needed to develop or test.
//
// Uses Vercel's named Web exports (GET/POST/OPTIONS) so the Node runtime sends
// the returned Response — a default `handler(req)` returning a Response is
// misread as the (req, res) Node style and the response is dropped.

const TTL_SECONDS = 300; // a pairing attempt should be well under this

type Kind = 'offer' | 'answer';
const isKind = (k: unknown): k is Kind => k === 'offer' || k === 'answer';
const key = (room: string, kind: Kind) => `signal:${room}:${kind}`;

// One client per serverless instance, reused across warm invocations.
// maxRetriesPerRequest is kept low so a dropped connection fails fast instead
// of holding the function open until it times out (ioredis still auto-reconnects).
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set');
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers });

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers });
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as {
      room?: unknown;
      kind?: unknown;
      sdp?: unknown;
    };
    const { room, kind, sdp } = body;
    if (typeof room !== 'string' || !room || !isKind(kind) || typeof sdp !== 'string') {
      return json({ error: 'expected { room, kind: offer|answer, sdp }' }, 400);
    }
    await redis.set(key(room, kind), sdp, 'EX', TTL_SECONDS);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const u = new URL(req.url);
    const room = u.searchParams.get('room');
    const kind = u.searchParams.get('kind');
    if (!room || !isKind(kind)) return json({ error: 'expected ?room=...&kind=offer|answer' }, 400);
    const sdp = await redis.get(key(room, kind));
    return json({ found: !!sdp, sdp: sdp ?? null });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
