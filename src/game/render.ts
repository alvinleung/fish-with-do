// Canvas renderer for the fishing scene. Pure drawing — all game state is
// passed in via `Scene`. Two players share one pond: P1 (red) on the left,
// P2 (blue) on the right. Each has its own rod, bobber, fight and HUD on its
// side of the screen; the sky, water and the water line are shared.

export const W = 960;
export const H = 600;
export const WATER_Y = 238;

export type PlayerId = 1 | 2;

// The rod is drawn from a per-player pivot (just below the screen) so it looks
// held in first person. P1's pivot is bottom-left, P2's bottom-right.
export const ROD_LEN = 470;
export const ROD_TIP_UP = true;

export type GameState = 'baiting' | 'idle' | 'casting' | 'waiting' | 'bite' | 'fight' | 'caught' | 'lost';

// Fixed, per-player geometry: where the rod is gripped, which way it leans, the
// stretch of water it can cast into, and which corner its HUD owns.
export interface PlayerLayout {
  id: PlayerId;
  color: string; // accent (bobber + HUD)
  pivot: { x: number; y: number };
  side: 1 | -1; // +1 = right (P2), -1 = left (P1)
  castMinX: number;
  castMaxX: number;
  align: 'left' | 'right';
  hudX: number;
}

export interface Ripple {
  x: number;
  y: number;
  r: number;
  max: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number; // age (s)
  ttl: number; // lifetime (s)
  size: number;
  color: string;
  kind: 'splash' | 'sparkle';
}

export interface PlayerScene {
  id: PlayerId;
  color: string;
  state: GameState;
  rodAngle: number;
  bobber: { x: number; y: number };
  bobberDip: number; // 0..1, how far the bobber is pulled under
  lineSlack: number; // 0 (taut) .. 1 (saggy)
  ripples: Ripple[];
  particles: Particle[];
  rodShake: number; // 0..1 rod-tug intensity (the fish pulling while not reeling)
  reelSpeed: number; // 0..1 — reeling hook position on the meter
  bandCenter: number; // 0..1 — sweet-spot band center
  bandHalf: number; // 0..~0.16 — sweet-spot band half-height
  inSpot: boolean; // is the hook inside the band right now
  bursting: boolean; // is the band currently surging (moving fast)
  progress: number; // 0..1 — net catch progress
  points: number;
  catchCount: number;
  lastName: string | null;
  flash: string | null;
  flashT: number; // 0..1 life of the flash text
  layout: PlayerLayout;
}

export interface Scene {
  t: number;
  players: PlayerScene[];
}

const deg = (d: number): number => (d * Math.PI) / 180;

export function rodAngleFor(aimX: number, side: 1 | -1): number {
  // Right-side (P2) base: aim -1 = rod flat over the water, +1 = steep.
  const base = deg(-112 + aimX * 38);
  // Left-side (P1) is a horizontal mirror of the right side.
  return side === 1 ? base : -base - Math.PI;
}

export function rodTip(rodAngle: number, pivot: { x: number; y: number }): { x: number; y: number } {
  return {
    x: pivot.x + Math.cos(rodAngle) * ROD_LEN,
    y: pivot.y + Math.sin(rodAngle) * ROD_LEN,
  };
}

let rodUrl = '';
export function setRodUrl(url: string): void {
  rodUrl = url;
}

export function draw(ctx: CanvasRenderingContext2D, s: Scene): void {
  drawSky(ctx, s.t);
  drawWater(ctx, s.t);
  for (const p of s.players) {
    drawRipples(ctx, p.ripples);
    drawParticles(ctx, p.particles);
    const tip = rodTip(p.rodAngle, p.layout.pivot);
    drawLine(ctx, tip, p.bobber, p.lineSlack);
    drawRod(ctx, p.rodAngle, s.t, p.rodShake, p.layout);
    drawBobber(ctx, p.bobber, p.bobberDip, s.t, p.state, p.color);
  }
  for (const p of s.players) drawPlayerHud(ctx, s.t, p);
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
  ctx.quadraticCurveTo((tip.x + bobber.x) / 2, (tip.y + bobber.y) / 2 + sag, bobber.x, bobber.y);
  ctx.strokeStyle = 'rgba(226,240,255,0.7)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

function drawRod(
  ctx: CanvasRenderingContext2D,
  angle: number,
  t: number,
  rodShake: number,
  layout: PlayerLayout
): void {
  const img = getImg(rodUrl);
  if (!img) return;
  const h = ROD_LEN;
  const w = (h * img.naturalWidth) / img.naturalHeight;
  // The fish tugs the rod tip while you're not reeling: a fast, small rotation
  // (about the grip) that scales with rodShake (0 = still, 1 = fighting hard).
  const wiggle =
    rodShake > 0 ? (Math.sin(t * 33) * 0.6 + Math.sin(t * 19 + 0.9) * 0.4) * rodShake * 0.055 : 0;
  ctx.save();
  ctx.translate(layout.pivot.x, layout.pivot.y);
  ctx.rotate(angle + Math.PI / 2 + wiggle);
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

function drawParticles(ctx: CanvasRenderingContext2D, parts: Particle[]): void {
  for (const p of parts) {
    const a = Math.max(0, 1 - p.t / p.ttl);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawBobber(
  ctx: CanvasRenderingContext2D,
  pos: { x: number; y: number },
  dip: number,
  t: number,
  state: GameState,
  color: string
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
  ctx.fillStyle = color;
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

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// The fight meter: a vertical track where a sweet-spot band drifts up and down.
// Your crank speed is the "hook" (a marker you keep inside the band). A catch
// progress bar fills alongside while you hold the spot. Drawn in this player's
// corner, mirrored for the right side.
function drawFightMeter(ctx: CanvasRenderingContext2D, p: PlayerScene): void {
  const aRight = p.layout.align === 'right';
  const mw = 30;
  const mh = 168;
  const my = 112;
  const mx = aRight ? p.layout.hudX - mw : p.layout.hudX;
  const surging = p.bursting;

  // Track.
  ctx.fillStyle = 'rgba(8,16,30,0.68)';
  ctx.fillRect(mx, my, mw, mh);

  // Sweet-spot band (turns warm while the fish is surging).
  const top = clamp01(p.bandCenter + p.bandHalf);
  const bot = clamp01(p.bandCenter - p.bandHalf);
  const yTop = my + (1 - top) * mh;
  const yBot = my + (1 - bot) * mh;
  ctx.fillStyle = surging ? 'rgba(255,150,60,0.30)' : 'rgba(61,220,132,0.32)';
  ctx.fillRect(mx, yTop, mw, yBot - yTop);
  ctx.strokeStyle = surging ? 'rgba(255,180,90,0.98)' : 'rgba(140,245,180,0.95)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mx, yTop);
  ctx.lineTo(mx + mw, yTop);
  ctx.moveTo(mx, yBot);
  ctx.lineTo(mx + mw, yBot);
  ctx.stroke();

  // Your reeling hook — glows green in the spot, amber when you've missed it.
  const hy = my + (1 - p.reelSpeed) * mh;
  ctx.fillStyle = p.inSpot ? '#9dffb4' : '#ffd24d';
  ctx.shadowColor = p.inSpot ? 'rgba(120,255,170,0.9)' : 'rgba(255,210,77,0.9)';
  ctx.shadowBlur = 8;
  ctx.fillRect(mx - (aRight ? 6 : 0), hy - 2.5, mw + 6, 5);
  ctx.shadowBlur = 0;
  ctx.fillStyle = p.inSpot ? '#d6ffe2' : '#ffe6a3';
  ctx.beginPath();
  if (aRight) {
    ctx.moveTo(mx - 6, hy);
    ctx.lineTo(mx - 13, hy - 6);
    ctx.lineTo(mx - 13, hy + 6);
  } else {
    ctx.moveTo(mx + mw + 6, hy);
    ctx.lineTo(mx + mw + 13, hy - 6);
    ctx.lineTo(mx + mw + 13, hy + 6);
  }
  ctx.closePath();
  ctx.fill();

  ctx.font = '700 11px system-ui, sans-serif';
  ctx.textAlign = aRight ? 'right' : 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(226,236,250,0.9)';
  ctx.fillText('REEL', aRight ? mx + mw : mx, my - 6);

  // Catch progress — fills while you hold the green, drains when you miss.
  const pw = 150;
  const ph = 14;
  const py = my + mh - ph;
  const px = aRight ? mx - 16 - pw : mx + mw + 16;
  ctx.font = '700 12px system-ui, sans-serif';
  ctx.textAlign = aRight ? 'right' : 'left';
  ctx.fillStyle = 'rgba(226,236,250,0.85)';
  ctx.fillText('CATCH', aRight ? px + pw : px, py - 6);
  ctx.fillStyle = 'rgba(8,16,30,0.65)';
  ctx.fillRect(px, py, pw, ph);
  const pg = ctx.createLinearGradient(px, 0, px + pw, 0);
  pg.addColorStop(0, '#2f8fd6');
  pg.addColorStop(1, '#7dd3fc');
  ctx.fillStyle = pg;
  const fw = (pw - 4) * clamp01(p.progress);
  ctx.fillRect(aRight ? px + pw - 2 - fw : px + 2, py + 2, fw, ph - 4);
  ctx.strokeStyle = 'rgba(226,240,255,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
}

function hintText(state: GameState): string {
  switch (state) {
    case 'baiting':
      return 'Pick a bait on your phone to start';
    case 'idle':
      return 'Throw the phone to cast';
    case 'casting':
      return '…';
    case 'waiting':
      return 'Waiting for a bite…';
    case 'bite':
      return 'STRIKE! Throw!';
    case 'fight':
      return 'Keep the reel in the green!';
    default:
      return '';
  }
}

function drawPlayerHud(ctx: CanvasRenderingContext2D, t: number, p: PlayerScene): void {
  const aRight = p.layout.align === 'right';
  ctx.textAlign = aRight ? 'right' : 'left';
  ctx.textBaseline = 'alphabetic';

  // Top: player label (colored) + score, in this player's corner.
  ctx.font = '800 14px system-ui, sans-serif';
  ctx.fillStyle = p.color;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 5;
  ctx.fillText(`PLAYER ${p.id}`, p.layout.hudX, 40);
  ctx.shadowBlur = 0;

  ctx.font = '600 14px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(226,236,250,0.9)';
  const score =
    `Points ${p.points} · Catches ${p.catchCount}` + (p.lastName ? ` · Last: ${p.lastName}` : '');
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 5;
  ctx.fillText(score, p.layout.hudX, 60);
  ctx.shadowBlur = 0;

  // This player's hint.
  const hint = hintText(p.state);
  if (hint) {
    const strike = p.state === 'bite';
    ctx.font = strike ? '800 24px system-ui, sans-serif' : '600 15px system-ui, sans-serif';
    ctx.fillStyle = strike
      ? `rgba(255,221,87,${(0.75 + 0.25 * Math.sin(t * 16)).toFixed(3)})`
      : 'rgba(226,236,250,0.88)';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 6;
    ctx.fillText(hint, p.layout.hudX, 88);
    ctx.shadowBlur = 0;
  }

  // The reeling sweet-spot meter, on this player's side.
  if (p.state === 'fight') {
    drawFightMeter(ctx, p);
  }

  // Flash (e.g. "It got away…") centered in this player's half.
  if (p.flash && p.flashT > 0) {
    const a = Math.min(1, p.flashT * 3) * Math.min(1, (1 - p.flashT) * 2.5);
    ctx.globalAlpha = Math.max(0, a);
    ctx.font = '800 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 10;
    ctx.fillText(p.flash, p.id === 1 ? W / 4 : (W * 3) / 4, H * 0.34);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.textAlign = aRight ? 'right' : 'left';
  }
}
