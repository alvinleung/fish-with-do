# Fish With Do

Steer a ball through a maze on your **computer** using the **accelerometer/tilt
of your phone**. The two browsers talk **peer-to-peer over WebRTC** — there is
**no backend server**. A free static host (Vercel) is only used to serve the
two web pages over **HTTPS**, which iOS requires for both the motion sensor and
WebRTC.

## How it works

- **Controller page** (phone, Safari): reads `DeviceOrientation`, normalizes the
  tilt to a `-1..1` vector, and streams `{ x, y }` at ~30 Hz over a WebRTC data
  channel.
- **Game page** (computer): a Matter.js maze. The incoming tilt sets the world
  gravity, so the ball rolls toward the direction you tilt. Reach the green goal.
- **Pairing (no signaling server):** the computer generates a WebRTC **offer**
  and shows a **QR code that points straight at the controller page** with the
  offer embedded in the URL (`controller.html?offer=…`). The phone scans it with
  its **system camera** (no in-app scanner), the controller page **reads the
  offer from the URL**, builds the **answer**, and you copy-paste the answer
  back into the computer (it auto-connects on paste). This uses
  `trickle: false` so each side produces a single self-contained SDP blob (all
  ICE candidates inline, loopback candidates trimmed) that fits in one QR / one
  paste.

## Stack

| Piece      | Choice |
|------------|--------|
| Build      | Vite + TypeScript (multi-page) |
| Hosting    | Vercel (free HTTPS static) |
| Sensor     | `DeviceOrientation` (iOS permission on tap) |
| Transport  | WebRTC via `simple-peer` (`trickle: false`) |
| Pairing    | `qrcode` (controller URL with embedded offer) + `URLSearchParams` |
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

## Pairing steps

1. On the **computer**, open the Game page. A QR code appears automatically
   (no button needed).
2. On the **phone**, scan the QR with the **system camera** (iPhone camera
   app). The Controller page opens by itself with the offer already in the URL.
3. Tap **Enable motion** (grant the iOS permission).
4. The phone shows your **answer**. Tap **Copy answer**.
5. On the **computer**, paste the answer into the answer box — it connects
   automatically (or click **Connect**).
6. Both show "connected" — tilt your phone to steer.

If the QR is too dense to scan, expand **"QR won't scan? Copy this URL to your
phone"** on the Game page, copy it, and open it in the phone's browser instead.
Use **New QR** to generate a fresh pairing link if a session goes stale.

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
- The connection is one-shot; if it drops, click **New QR** and re-pair.
- The data channel carries only tiny tilt JSON, so bandwidth is negligible.
