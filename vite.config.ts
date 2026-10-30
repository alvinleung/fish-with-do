import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// Multi-page static site: a landing page plus the phone controller and the
// computer game. Both are served over HTTPS on Vercel so the phone's
// DeviceOrientation API and WebRTC are available.
//
// simple-peer is a Node library, so we polyfill the Node globals/modules its
// dependency chain (readable-stream, buffer, ...) expects in the browser.

// Local stand-in for the Vercel /api/signal relay (see api/signal.ts). Vercel
// serverless functions don't run under `vite dev`/`preview`, so we mount an
// in-memory relay at the same path. It is only active locally — the static
// build shipped to Vercel never includes it.
function localSignalRelay(): Plugin {
  const store = new Map<string, { sdp: string; at: number }>();
  const TTL_MS = 5 * 60 * 1000;
  const prune = () => {
    const now = Date.now();
    for (const [k, v] of store) if (now - v.at > TTL_MS) store.delete(k);
  };
  const handler: Connect.NextHandleFunction = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    const send = (status: number, obj: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') return send(204, null);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST') {
      let data = '';
      req.on('data', (c: Buffer) => (data += c));
      req.on('end', () => {
        try {
          const { room, kind, sdp } = JSON.parse(data) as {
            room?: unknown;
            kind?: unknown;
            sdp?: unknown;
          };
          if (typeof room !== 'string' || !room || (kind !== 'offer' && kind !== 'answer') || typeof sdp !== 'string') {
            return send(400, { error: 'bad request' });
          }
          prune();
          store.set(`signal:${room}:${kind}`, { sdp, at: Date.now() });
          send(200, { ok: true });
        } catch {
          send(400, { error: 'parse error' });
        }
      });
      return;
    }
    if (req.method === 'GET') {
      const room = url.searchParams.get('room');
      const kind = url.searchParams.get('kind');
      if (!room || (kind !== 'offer' && kind !== 'answer')) return send(400, { error: 'bad request' });
      prune();
      const v = store.get(`signal:${room}:${kind}`);
      send(200, { found: !!v, sdp: v ? v.sdp : null });
      return;
    }
    send(405, { error: 'method not allowed' });
  };
  // NOTE: must not return the result of `.use()` — a Vite configure*Server
  // hook that returns a function is treated as a "post hook" and invoked with
  // no arguments, which would crash the server.
  const mount = (server: { middlewares: Connect }) => {
    server.middlewares.use('/api/signal', handler);
  };
  return {
    name: 'local-signal-relay',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}

export default defineConfig({
  base: './',
  plugins: [
    localSignalRelay(),
    nodePolyfills({
      include: ['buffer', 'events', 'process', 'stream', 'string_decoder', 'util'],
      globals: { global: true, Buffer: true, process: true },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        controller: 'controller.html',
        game: 'game.html',
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
