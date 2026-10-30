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
  and shows it as a **QR code**. The phone **scans** it (camera), builds the
  **answer**, and you copy-paste the answer back into the computer. Both sides
  connect. This uses `trickle: false` so each side produces a single
  self-contained SDP blob (all ICE candidates inline) that fits in one QR / one
  paste.

## Stack

| Piece      | Choice |
|------------|--------|
| Build      | Vite + TypeScript (multi-page) |
| Hosting    | Vercel (free HTTPS static) |
| Sensor     | `DeviceOrientation` (iOS permission on tap) |
| Transport  | WebRTC via `simple-peer` (`trickle: false`) |
| Pairing    | `qrcode` (offer/answer) + `jsQR` (phone camera scan) |
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

1. On the **computer**, open the Game page and click **New session**. A QR code
   appears (the offer).
2. On the **phone**, open the Controller page, tap **Enable motion** (grant the
   iOS permission), then **Scan offer QR** and point the camera at the computer
   screen.
3. The phone shows your **answer**. Tap **Copy answer**.
4. On the **computer**, paste the answer and click **Connect**.
5. Both show "connected" — tilt your phone to steer.

If QR scanning is fiddly, use the "copy offer / paste offer" fallback on each
page. If the computer has a webcam, it can also scan the phone's answer QR.

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
- The connection is one-shot; if it drops, run **New session** and re-pair.
- The data channel carries only tiny tilt JSON, so bandwidth is negligible.
