// Returns Twilio Network Traversal Service (NTS) ICE servers for the WebRTC link.
//
// Twilio NTS is a globally-distributed anycast STUN/TURN service. It's the
// primary TURN path because it's reachable from cellular networks (e.g. T-Mobile)
// that block our own VPS. The token it returns is ephemeral (24h), and the
// Twilio credentials stay server-side (env vars), so nothing sensitive ships in
// the client bundle.
//
// Vercel serverless functions don't run under `vite dev`/`preview`, so there is
// no /api/nts locally — the client (shared/link.ts) falls back to the static
// STUN + VPS TURN config in that case.
//
// Uses Vercel's named Web exports (GET/OPTIONS), matching api/signal.ts.

type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers });

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers });
}

export async function GET(): Promise<Response> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    return json({ error: 'Twilio credentials not configured on the server' }, 500);
  }
  try {
    const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Tokens.json`,
      { method: 'POST', headers: { Authorization: auth } },
    );
    if (!res.ok) {
      return json({ error: `Twilio token request failed (HTTP ${res.status})` }, 502);
    }
    const data = (await res.json()) as { ice_servers?: IceServer[] };
    return json({ iceServers: Array.isArray(data.ice_servers) ? data.ice_servers : [] });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
