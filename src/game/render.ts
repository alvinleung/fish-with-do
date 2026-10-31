// Canvas renderer for the fishing scene. Pure drawing — all game state is
// passed in via `Scene`. Tunable world constants live at the top.

export const W = 960;
export const H = 600;
export const WATER_Y = 238;

// The rod is drawn from this pivot (just below the screen, bottom-right) so it
// looks held in first person. ROD_LEN is the on-screen pivot-to-tip length.
export const PIVOT = { x: 818, y: H + 26 };
export const ROD_LEN = 470;
// The rod art (766x1616) is assumed tip-up / grip-down. Flip these if the art
// is oriented differently.
export const ROD_TIP_UP = true;
export const ROD_FH = false;

export type GameState = 'idle' | 'casting' | 'waiting' | 'bite' | 'fight' | 'caught' | 'lost';

export interface FishView {
  img: string;
  x: number;
  y: number;
  size: number;
  dir: 1 | -1;
  alpha: number;
  rot: number;
}

export interface Ripple {
  x: number;
  y: number;
  r: number;
  max: number;
}

export interface Scene {
  t: number;
  state: GameState;
  rodAngle: number;
  bobber: { x: number; y: number };
  bobberDip: number; // 0..1, how far the bobber is pulled under
  lineSlack: number; // 0 (taut) .. 1 (saggy)
  fish: FishView | null;
  ambient: FishView[];
  ripples: Ripple[];
  tension: number;
  progress: number;
  points: number;
  catchCount: number;
  lastName: string | null;
  flash: string | null;
  flashT: number; // 0..1 life of the flash text
}

const deg = (d: number): number => (d * Math.PI) / 180;

export function rodAngleFor(aimX: number): number {
  // aim -1 (tilt left) = rod flat over the water, +1 (tilt right) = steep.
  return deg(-112 + aimX * 38);
}

export function rodTip(rodAngle: number): { x: number; y: number } {
  return {
    x: PIVOT.x + Math.cos(rodAngle) * ROD_LEN,
    y: PIVOT.y + Math.sin(rodAngle) * ROD_LEN,
  };
}

let rodUrl = '';
export function setRodUrl(url: string): void {
  rodUrl = url;
}

export function draw(ctx: CanvasRenderingContext2D, s: Scene): void {
  drawSky(ctx, s.t);
  drawWater(ctx, s.t);
  drawRipples(ctx, s.ripples);
  for (const f of s.ambient) drawFish(ctx, f);
  if (s.fish) drawFish(ctx, s.fish);
  const tip = rodTip(s.rodAngle);
  drawLine(ctx, tip, s.bobber, s.lineSlack);
  drawRod(ctx, s.rodAngle);
  drawBobber(ctx, s.bobber, s.bobberDip, s.t, s.state);
  drawHud(ctx, s);
}

function drawSky(ctx: CanvasRenderingContext2D, t: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, WATER_Y);
  sky.addColorStop(0, '#0e1a36');
  sky.addColorStop(0.62, '#2d4f86');
  sky.addColorStop(1, '#c8824d');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, WATER_Y);

  const sunY = WATER_Y - 64;
  const glow = ctx.createRadialGradient(170, sunY, 6, 170, sunY, 150);
  glow.addColorStop(0, 'rgba(255,196,120,0.55)');
  glow.addColorStop(1, 'rgba(255,196,120,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(10, sunY - 150, 320, 300);
  ctx.beginPath();
  ctx.arc(170, sunY, 30, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd9a0';
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  for (let i = 0; i < 3; i++) {
    const cx = ((t * 6 + i * 380) % (W + 240)) - 120;
    const cy = 60 + i * 44;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 74, 12, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + 40, cy + 8, 46, 9, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#0c2033';
  ctx.beginPath();
  ctx.moveTo(0, WATER_Y);
  ctx.lineTo(0, WATER_Y - 26);
  ctx.quadraticCurveTo(180, WATER_Y - 58, 380, WATER_Y - 22);
  ctx.quadraticCurveTo(560, WATER_Y - 8, 720, WATER_Y - 40);
  ctx.quadraticCurveTo(850, WATER_Y - 60, W, WATER_Y - 24);
  ctx.lineTo(W, WATER_Y);
  ctx.closePath();
  ctx.fill();
}

function drawWater(ctx: CanvasRenderingContext2D, t: number): void {
  const water = ctx.createLinearGradient(0, WATER_Y, 0, H);
  water.addColorStop(0, '#2f6f9f');
  water.addColorStop(0.22, '#16507f');
  water.addColorStop(1, '#071c38');
  ctx.fillStyle = water;
  ctx.fillRect(0, WATER_Y, W, H - WATER_Y);

  const refl = ctx.createLinearGradient(0, WATER_Y, 0, H);
  refl.addColorStop(0, 'rgba(255,190,110,0.22)');
  refl.addColorStop(1, 'rgba(255,190,110,0)');
  ctx.fillStyle = refl;
  ctx.fillRect(130, WATER_Y, 90, H - WATER_Y);

  ctx.fillStyle = '#cfeaff';
  for (let i = 0; i < 7; i++) {
    const y = WATER_Y + 16 + i * 27 + Math.sin(t * 0.6 + i * 1.7) * 2.5;
    const off = (t * 14 + i * 97) % 150;
    ctx.globalAlpha = 0.045 + 0.03 * (0.5 + 0.5 * Math.sin(i * 2.3 + t * 0.8));
    for (let x = -150 + off; x < W; x += 150) {
      ctx.fillRect(x, y, 48, 2);
    }
  }
  ctx.globalAlpha = 1;
}

function drawRipples(ctx: CanvasRenderingContext2D, ripples: Ripple[]): void {
  for (const r of ripples) {
    const a = Math.max(0, 1 - r.r / r.max) * 0.5;
    ctx.beginPath();
    ctx.ellipse(r.x, r.y, r.r, r.r * 0.32, 0, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(220,240,255,${a.toFixed(3)})`;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  tip: { x: number; y: number },
  bobber: { x: number; y: number },
  slack: number
): void {
  const dist = Math.hypot(bobber.x - tip.x, bobber.y - tip.y);
  const sag = slack * 30 * (dist / 420);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.quadraticCurveTo(
    (tip.x + bobber.x) / 2,
    (tip.y + bobber.y) / 2 + sag,
    bobber.x,
    bobber.y
  );
  ctx.strokeStyle = 'rgba(226,240,255,0.7)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

function drawRod(ctx: CanvasRenderingContext2D, angle: number): void {
  const img = getImg(rodUrl);
  if (!img) return;
  const h = ROD_LEN;
  const w = (h * img.naturalWidth) / img.naturalHeight;
  ctx.save();
  ctx.translate(PIVOT.x, PIVOT.y);
  ctx.rotate(angle + Math.PI / 2);
  if (ROD_FH) ctx.scale(-1, 1);
  if (!ROD_TIP_UP) ctx.scale(1, -1);
  ctx.drawImage(img, -w / 2, ROD_TIP_UP ? -h : 0, w, h);
  ctx.restore();
}

const imgCache = new Map<string, HTMLImageElement>();
function getImg(url: string): HTMLImageElement | null {
  let img = imgCache.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    imgCache.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

function drawFish(ctx: CanvasRenderingContext2D, f: FishView): void {
  const img = getImg(f.img);
  if (!img) return;
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(f.rot);
  ctx.scale(f.dir, 1);
  ctx.globalAlpha = f.alpha;
  ctx.drawImage(img, -f.size / 2, -f.size / 2, f.size, f.size);
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawBobber(
  ctx: CanvasRenderingContext2D,
  pos: { x: number; y: number },
  dip: number,
  t: number,
  state: GameState
): void {
  const r = 9;
  const y = pos.y + dip * 11;
  ctx.save();
  ctx.translate(pos.x, y);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = '#f4f6fb';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r, Math.PI, Math.PI * 2);
  ctx.fillStyle = '#e23b3b';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(10,20,35,0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-3, -3, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fill();
  ctx.restore();

  if (state === 'bite') {
    const pulse = 1 + 0.18 * Math.sin(t * 18);
    ctx.save();
    ctx.translate(pos.x, y - 46 * pulse);
    ctx.scale(pulse, pulse);
    ctx.font = '900 40px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffdd57';
    ctx.strokeStyle = 'rgba(60,20,0,0.8)';
    ctx.lineWidth = 5;
    ctx.strokeText('!', 0, 0);
    ctx.fillText('!', 0, 0);
    ctx.restore();
  }
}

function bar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  v: number,
  label: string,
  colors: [string, string, string]
): void {
  ctx.font = '700 12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(226,236,250,0.85)';
  ctx.fillText(label, x, y - 6);

  ctx.fillStyle = 'rgba(8,16,30,0.65)';
  ctx.fillRect(x, y, w, h);
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, colors[0]);
  g.addColorStop(0.55, colors[1]);
  g.addColorStop(1, colors[2]);
  ctx.fillStyle = g;
  ctx.fillRect(x + 2, y + 2, (w - 4) * Math.max(0, Math.min(1, v)), h - 4);
  ctx.strokeStyle = 'rgba(226,240,255,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function drawHud(ctx: CanvasRenderingContext2D, s: Scene): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const hint =
    s.state === 'idle'
      ? 'Flick the phone to throw (or Space) to cast'
      : s.state === 'casting'
        ? '…'
        : s.state === 'waiting'
          ? 'Waiting for a bite… flick to recast'
          : s.state === 'bite'
            ? 'STRIKE! Tap now!'
            : s.state === 'fight'
              ? 'CRANK! Spin the wheel on your phone — ease off when it pulls hard'
              : '';

  if (hint) {
    const strike = s.state === 'bite';
    ctx.font = strike ? '800 26px system-ui, sans-serif' : '600 16px system-ui, sans-serif';
    ctx.fillStyle = strike
      ? `rgba(255,221,87,${(0.75 + 0.25 * Math.sin(s.t * 16)).toFixed(3)})`
      : 'rgba(226,236,250,0.9)';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 6;
    ctx.fillText(hint, 20, 38);
    ctx.shadowBlur = 0;
  }

  ctx.font = '600 14px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(226,236,250,0.85)';
  const top = `Points ${s.points}   ·   Catches ${s.catchCount}` + (s.lastName ? `   ·   Last: ${s.lastName}` : '');
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 5;
  ctx.fillText(top, W - 20, 34);
  ctx.shadowBlur = 0;
  ctx.textAlign = 'left';

  if (s.state === 'fight' || s.state === 'caught') {
    bar(ctx, 20, H - 46, 300, 16, s.tension, 'LINE TENSION', ['#3ddc84', '#ffd94d', '#ff4d4d']);
    bar(ctx, 340, H - 46, 300, 16, s.progress, 'LINE RECOVERED', ['#38bdf8', '#38bdf8', '#7dd3fc']);
  }

  if (s.flash && s.flashT > 0) {
    const a = Math.min(1, s.flashT * 3) * Math.min(1, (1 - s.flashT) * 2.5);
    ctx.globalAlpha = Math.max(0, a);
    ctx.font = '800 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 10;
    ctx.fillText(s.flash, W / 2, H * 0.34);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }
}
