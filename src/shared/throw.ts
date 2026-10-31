// Detects a quick "throw" flick of the phone from the accelerometer.
//
// iOS only exposes accelerationIncludingGravity (no user-acceleration with
// gravity removed), so we measure how fast the vector magnitude changes from
// event to event and accumulate it into a decaying energy value. A throw
// dumps enough energy in ~200 ms to cross the threshold; holding, walking or
// tapping the wheel does not. The threshold is exported so the controller can
// draw a live meter and be calibrated while testing.
export const THROW_ENERGY_THRESHOLD = 14;

const DECAY = 0.86; // per event (~60 Hz) — a ~200 ms memory window
const COOLDOWN_MS = 1200;

export function startThrowDetection(
  onThrow: () => void,
  onEnergy?: (energy: number) => void
): () => void {
  let prevMag: number | null = null;
  let energy = 0;
  let lastThrow = 0;

  const handler = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null) return;
    const mag = Math.hypot(a.x, a.y, a.z);
    if (prevMag !== null) {
      energy = (energy + Math.abs(mag - prevMag)) * DECAY;
      const now = performance.now();
      if (energy >= THROW_ENERGY_THRESHOLD && now - lastThrow > COOLDOWN_MS) {
        lastThrow = now;
        energy = 0;
        onThrow();
      }
    }
    prevMag = mag;
    onEnergy?.(energy);
  };

  window.addEventListener('devicemotion', handler);
  return () => window.removeEventListener('devicemotion', handler);
}
