// Shared message protocol and tilt math used by both the phone
// (controller) and the computer (game).

export type TiltMsg = { kind: 'tilt'; x: number; y: number };
export type HelloMsg = { kind: 'hello' };
export type WinMsg = { kind: 'win'; time: number };
export type Msg = TiltMsg | HelloMsg | WinMsg;

// How many degrees of phone tilt map to a full deflection (-1..1).
export const MAX_TILT_DEG = 30;
// How often the phone streams tilt (ms). ~30 Hz is plenty for steering.
export const SEND_INTERVAL_MS = 33;

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// gamma: left/right tilt (-90..90), beta: front/back tilt (-180..180).
// Returned as a normalized vector in [-1, 1].
export function normalizeTilt(gamma: number, beta: number): { x: number; y: number } {
  return {
    x: clamp(gamma / MAX_TILT_DEG, -1, 1),
    y: clamp(beta / MAX_TILT_DEG, -1, 1),
  };
}
