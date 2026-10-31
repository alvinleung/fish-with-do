# Fish With Do

**Fish With Do** is a party fishing game: the **computer screen is the lake**,
and your **phone is the reel** you hold in your hand. The two browsers talk
**peer-to-peer over WebRTC** — gameplay never touches a server. A tiny
**serverless signaling relay** (Vercel function + Vercel KV) is used **only for
the one-time pairing handshake**.

## The controls

Hold the phone like a fishing rod:

- **Lean left/right** (tilt) → the rod on screen sweeps (aim far or near for
  the cast).
- **Flick the phone** (throw motion) → cast with full power: the lure flies
  farther, faster and higher. Flick again while the line is in the water to
  re-throw it. Detected from the accelerometer — a quick spike in how fast
  the acceleration magnitude changes (`src/shared/throw.ts`, threshold
  `THROW_ENERGY_THRESHOLD`).
- **Spin the wheel with your finger** (rotary touch gesture on the phone) →
  crank the reel in; every 30° fires a ratchet **haptic tick** (plus a click
  sound, since iPhones can't vibrate from the web).
- **Tap the wheel** → strike the bite, or continue after a catch.

While a fish is hooked, the phone also **buzzes back at you**: a tap when it
takes the line, a pattern when you land it, a long one when the line snaps.

## How it works

- **Controller page** (phone, Safari): reads `DeviceOrientation`. Tilt
  (lean left/right) is normalized to `-1..1` and centered on your actual grip.
  Cranking is a **rotary touch gesture** on the on-screen wheel — the finger's
  angle around the wheel center is tracked and its rate of change becomes the
   crank speed `v`. Frames go out at ~30 Hz over a WebRTC data channel as
   `{ x, y, v }`. A **throw flick** is detected from `DeviceMotion`
   (accelerometer) and sent as a separate `{ kind: 'throw' }` message.
- **Game page** (computer): a canvas fishing scene. Tilt steers the rod, and
  the fight is a tension-vs-progress minigame: crank during the fish's rest
  phases, ease off during its pulls, or the line snaps. Catch fish (trout,
  carp, bass, salmon) — or junk (CDs and bags, keep the water clean).
- **Pairing (one scan, auto-connect):** the computer shows a **QR code** that
  points at the controller page carrying a 4-letter room code. The phone scans
  it with its system camera, the two sides rendezvous through the relay, and
  the WebRTC data channel opens with no copy/paste.

## Stack

| Piece      | Choice |
|------------|--------|
| Build      | Vite + TypeScript (multi-page) |
| Hosting    | Vercel (free HTTPS static + serverless function) |
| Sensor     | `DeviceOrientation` (beta/gamma tilt) + `DeviceMotion` (throw flick), iOS permission on tap |
| Cast       | Throw flick of the phone (accelerometer spike) or tap the wheel |
| Crank      | Rotary touch gesture on the wheel (finger angle around center) |
| Feedback   | `navigator.vibrate` (Android) + WebAudio ratchet click (everywhere) |
| Transport  | WebRTC via `simple-peer` (`trickle: false`) — P2P, no server relay of gameplay |
| Pairing    | `qrcode` (room-code URL) + a `/api/signal` relay (Vercel function + KV) |
| Game       | Canvas 2D scene + hand-rolled state machine |

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

**Play with no phone:** on the game page, `A`/`D` (or arrows) aim the rod,
`W` cranks the reel, `S` lets line out, `Space` casts/strikes.

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
   code** appear automatically.
2. On the **phone**, scan the QR with the **system camera** (iPhone camera
   app). The controller page opens by itself.
3. That's it — both sides show **"connected"**.
4. Tap **Enable motion** (grant the iOS permission), hold the phone like a
   rod, and start fishing.

If the QR won't scan, expand **"QR won't scan? Open this URL on your phone"**
on the Game page. Use **New code** to generate a fresh room if a session goes
stale.

## Tuning

- **Rod sweep range:** `rodAngleFor()` in `src/game/render.ts`.
- **Cast distance:** `startCast()` in `src/game/main.ts`.
- **Fight feel:** the `tension`/`progress` coefficients in the `fight` case of
  `update()` in `src/game/main.ts`; bite window in `BITE_WINDOW`.
- **Catch table:** species, pull strength, sizes, points and rarity in
  `src/game/fish.ts`.
- **Tilt sensitivity:** `MAX_TILT_DEG` in `src/shared/protocol.ts`.
- **Full-crank threshold:** `MAX_CRANK_RAD_S` in `src/shared/protocol.ts`.
- **Rod/reel art orientation:** `ROD_TIP_UP` / `ROD_FH` in
  `src/game/render.ts` (flip if the art is oriented differently).
- **Work across different networks:** add a STUN server to `RTC_CONFIG` in
  `src/shared/link.ts`. The default (Google STUN) already covers most cases.

## Notes & limits

- iOS requires a **user gesture** to grant motion permission, hence the
  **Enable motion** button, and the page must be **HTTPS**.
- **iPhones cannot vibrate from a web page** (Safari has no Vibration API).
  The ratchet click sound covers that; Android phones get real haptics.
- Spinning the wheel won't scroll the page: the wheel has `touch-action: none`,
  so all touch motion on it is consumed by the crank gesture.
- The connection is one-shot; if it drops, click **New code** and re-pair.
- The relay only carries the one-time handshake SDP (a few KB) and drops it
  after ~5 minutes; it never sees any gameplay data.
