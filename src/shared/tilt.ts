import { normalizeTilt, SEND_INTERVAL_MS } from './protocol';

// iOS requires an explicit, user-gesture-triggered permission request before
// DeviceOrientation/DeviceMotion fire. Other browsers have no such API and we
// simply proceed.
export async function requestMotionPermission(): Promise<boolean> {
  const doe = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  const dme = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
  const requests: Promise<string>[] = [];
  if (typeof doe?.requestPermission === 'function') requests.push(doe.requestPermission());
  if (typeof dme?.requestPermission === 'function') requests.push(dme.requestPermission());
  if (requests.length === 0) return true;
  try {
    const results = await Promise.all(requests);
    return results.every((r) => r === 'granted');
  } catch {
    return false;
  }
}

export type TiltSample = {
  x: number; // normalized steering, -1..1
  y: number; // normalized steering, -1..1
  gamma: number; // raw device degrees (left/right)
  beta: number; // raw device degrees (front/back)
};

// Starts listening to deviceorientation and calls onTilt with a lightly
// low-passed, normalized {x, y} at roughly 30 Hz. Returns a stop function.
//
// The control is centered on the orientation the phone is actually held at when
// motion starts (averaged over the first ~15 events), not on "perfectly flat".
// beta is not 0-based in the way flat-holding assumes, so without this offset
// one axis is already saturated for most grips and the ball can't steer that way.
export function startTilt(onTilt: (v: TiltSample) => void): () => void {
  let smooth = { x: 0, y: 0 };
  let last = 0;

  // Baseline = average of the first BASE_SAMPLES readings (how the user is
  // holding the phone). Tilt is reported relative to this.
  const BASE_SAMPLES = 15; // ~250 ms at 60 Hz
  let sumGamma = 0;
  let sumBeta = 0;
  let samples = 0;
  let baseGamma = 0;
  let baseBeta = 0;
  let centered = false;

  const handler = (e: DeviceOrientationEvent) => {
    const gamma = e.gamma ?? 0;
    const beta = e.beta ?? 0;

    if (!centered) {
      sumGamma += gamma;
      sumBeta += beta;
      samples += 1;
      if (samples >= BASE_SAMPLES) {
        baseGamma = sumGamma / samples;
        baseBeta = sumBeta / samples;
        centered = true;
      }
      return; // don't emit until we have a stable center
    }

    const now = performance.now();
    if (now - last < SEND_INTERVAL_MS) return;
    last = now;
    const t = normalizeTilt(gamma - baseGamma, beta - baseBeta);
    smooth.x = smooth.x * 0.7 + t.x * 0.3;
    smooth.y = smooth.y * 0.7 + t.y * 0.3;
    onTilt({ x: smooth.x, y: smooth.y, gamma, beta });
  };

  window.addEventListener('deviceorientation', handler);
  return () => window.removeEventListener('deviceorientation', handler);
}
