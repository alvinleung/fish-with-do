# Fish With Do

Steer a ball through a maze on your **computer** using the **accelerometer/tilt
of your phone**. The two browsers talk **peer-to-peer over WebRTC** — the
gameplay never touches a server. A tiny **serverless signaling relay** (a Vercel
function + Vercel KV) is used **only for the one-time pairing handshake**; after
that, all tilt data flows directly between the two devices.

## How it works

- **Controller page** (phone, Safari): reads `DeviceOrientation`, normalizes the
  tilt to a `-1..1` vector, and streams `{ x, y }` at ~30 Hz over a WebRTC data
  channel.
- **Game page** (computer): a Matter.js maze. The incoming tilt sets the world
  gravity, so the ball rolls toward the direction you tilt. Reach the green goal.
- **Pairing (one scan, auto-connect):** the computer picks a short **room code**
  and shows a **QR code that points at the controller page** carrying just that
  code (`controller.html?room=CODE`). It posts its WebRTC **offer** to the relay
  and starts polling for the **answer**. The phone scans the QR with its
  **system camera** (no in-app scanner), reads the room code from the URL, polls
  the relay for the offer, builds the **answer**, and posts it back. The two
  rendezvous through the relay and the WebRTC connection opens with no
  copy/paste. Each side emits one self-contained SDP blob (`trickle: false`,
  all ICE candidates inline, loopback trimmed).

## Stack

| Piece      | Choice |
|------------|--------|
| Build      | Vite + TypeScript (multi-page) |
| Hosting    | Vercel (free HTTPS static + serverless function) |
| Sensor     | `DeviceOrientation` (iOS permission on tap) |
| Transport  | WebRTC via `simple-peer` (`trickle: false`) — P2P, no server relay of gameplay |
| Pairing    | `qrcode` (room-code URL) + a `/api/signal` relay (Vercel function + KV) |
| Game       | Matter.js 2D physics, custom canvas renderer |

## Run locally

```bash
npm install
npm run dev
```

Open on the **computer**: http://localhost:5173/game.html
Open on the **phone**: http://<your-computer-LAN-IP>:5173/controller.html

> The phone must reach the page over the same network. `npm run dev` binds to
> the LAN (Vite `server.host`). For the real experience use the HTTPS deploy
> below, because iOS only exposes the motion sensor in a secure context.

## Deploy (recommended)

```bash
npx vercel
```

or push to a repo and import it in the Vercel dashboard (the Vite framework is
auto-detected). You get two HTTPS URLs:

- `<app>.vercel.app/controller.html` → open on the phone
- `<app>.vercel.app/game.html` → open on the computer

### Enable the signaling relay (one-time)

Pairing uses `/api/signal`, a serverless function backed by **Vercel KV**
(Redis). Link a KV store to the project so the function can read/write it:

1. In the Vercel dashboard: **Project → Storage → Add Integration → Vercel KV**
   (or `npx vercel kv add`). Vercel injects `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` into the function automatically.
2. Re-deploy. KV has a free tier, which is far more than this needs.

> Locally you don't need KV: `npm run dev` / `npm run preview` mount an
> in-memory relay at the same `/api/signal` path (see `vite.config.ts`).

## Pairing steps

1. On the **computer**, open the Game page. A QR code and a 4-letter **room
   code** appear automatically (no button needed).
2. On the **phone**, scan the QR with the **system camera** (iPhone camera
   app). The Controller page opens by itself.
3. That's it — the phone and computer exchange the WebRTC handshake through the
   relay and both show **"connected"**. No copy/paste.
4. Tap **Enable motion** (grant the iOS permission) and tilt to steer.

If the QR won't scan, expand **"QR won't scan? Open this URL on your phone"**
on the Game page and open that URL in the phone's browser instead. Use
**New code** to generate a fresh room if a session goes stale.

## Tuning

- **Gravity feel:** `GRAVITY_SCALE`, `INVERT_X`, `INVERT_Y` in
  `src/game/main.ts`.
- **Tilt sensitivity:** `MAX_TILT_DEG` in `src/shared/protocol.ts`.
- **The maze:** edit `WALLS` in `src/game/maze.ts` (a list of rectangles in a
  900×560 space).
- **Work across different networks:** add a STUN server to `RTC_CONFIG` in
  `src/shared/link.ts`. The default (no STUN) is fastest for two devices on the
  same LAN / phone hotspot, which is the intended "same place" setup.

## Notes & limits

- iOS requires a **user gesture** to grant motion permission, hence the
  **Enable motion** button, and the page must be **HTTPS**.
- The connection is one-shot; if it drops, click **New code** and re-pair.
- The relay only carries the one-time handshake SDP (a few KB) and drops it
  after ~5 minutes; it never sees any gameplay data.
- The data channel carries only tiny tilt JSON, so bandwidth is negligible.
