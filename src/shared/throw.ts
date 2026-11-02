// Detects a quick flick of the phone from the accelerometer and tells apart a
// THROW (tossed away) from a YANK (pulled back toward you) — the two opposite
// directions of the same motion.
//
// iOS only exposes accelerationIncludingGravity (no user-acceleration with
// gravity removed), so we measure how fast the vector magnitude changes from
// event to event and accumulate it into a decaying energy value. A flick dumps
// enough energy in ~200 ms to cross the threshold; holding, walking or tapping
// the wheel does not.
//
// Direction: we also accumulate the signed change along the device Z axis (out
// of the screen, toward the holder). Pulling the phone back makes it positive;
// tossing it away makes it negative. A flick with a clear toward-component is a
// YANK (strike); any other strong flick is a THROW (cast). Both thresholds are
// exported so the controller can be calibrated while testing.
export const THROW_ENERGY_THRESHOLD = 14;
export const YANK_MIN_Z = 3; // signed z-energy that counts as "pulled toward you"

const DECAY = 0.86; // per event (~60 Hz) — a ~200 ms memory window
const COOLDOWN_MS = 1200;

export function startThrowDetection(
  onThrow: () => void,
  onYank: () => void,
  onEnergy?: (energy: number) => void
): () => void {
  let prevMag: number | null = null;
  let prevZ = 0;
  let energy = 0;
  let zdir = 0;
  let lastFlick = 0;

  const handler = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null) return;
    const mag = Math.hypot(a.x, a.y, a.z);
    const z = a.z;
    if (prevMag !== null) {
      energy = (energy + Math.abs(mag - prevMag)) * DECAY;
      zdir = (zdir + (z - prevZ)) * DECAY;
      const now = performance.now();
      if (energy >= THROW_ENERGY_THRESHOLD && now - lastFlick > COOLDOWN_MS) {
        lastFlick = now;
        const isYank = zdir > YANK_MIN_Z;
        energy = 0;
        zdir = 0;
        if (isYank) onYank();
        else onThrow();
      }
    }
    prevMag = mag;
    prevZ = z;
    onEnergy?.(energy);
  };

  window.addEventListener('devicemotion', handler);
  return () => window.removeEventListener('devicemotion', handler);
}
