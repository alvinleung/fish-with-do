// Shared message protocol and tilt math used by both the phone
// (controller) and the computer (game).

// One frame from the phone: tilt steering (x, y in -1..1) plus the crank
// speed in rad/s (positive = cranking the reel forward).
export type CtrlMsg = { kind: 'ctrl'; x: number; y: number; v: number };
// Tap on the phone screen: cast / strike / continue.
export type TapMsg = { kind: 'tap' };
// A physical throw flick of the phone: cast with full power.
export type ThrowMsg = { kind: 'throw' };
// Game -> phone: vibrate for ms (or a pattern). No-op where unsupported.
export type HapticMsg = { kind: 'haptic'; ms: number | number[] };
export type HelloMsg = { kind: 'hello' };
export type Msg = CtrlMsg | TapMsg | ThrowMsg | HapticMsg | HelloMsg;

// How many degrees of phone tilt map to a full deflection (-1..1).
export const MAX_TILT_DEG = 30;
// How often the phone streams control frames (ms). ~30 Hz is plenty.
export const SEND_INTERVAL_MS = 33;
// Crank speed (rad/s) that counts as "full crank" in the fight. 5 rad/s is a
// brisk but comfortable wrist twist (~0.8 turns/second).
export const MAX_CRANK_RAD_S = 5;

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

// Wrap an angle delta to [-180, 180] degrees (alpha wraps at 360).
export function wrapDeg(d: number): number {
  return ((d + 180) % 360 + 360) % 360 - 180;
}
