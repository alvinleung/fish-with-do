import { normalizeTilt, SEND_INTERVAL_MS, wrapDeg } from './protocol';

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
  twist: number; // wrist-twist (reel crank) speed, deg/s, smoothed
  gamma: number; // raw device degrees (left/right)
  beta: number; // raw device degrees (front/back)
  alpha: number; // raw device degrees (rotation about the screen normal)
};

// Starts listening to deviceorientation and calls onTilt at roughly 30 Hz with:
//  - {x, y}: tilt relative to the grip the phone is held in (centered on the
//    first ~15 events, low-passed). This steers the rod.
//  - twist: how fast the phone is rotating about its screen normal (alpha),
//    i.e. the wrist motion of cranking a reel. The zero of alpha is arbitrary
//    per device, so only its rate of change is used.
export function startTilt(onTilt: (v: TiltSample) => void): () => void {
  let smooth = { x: 0, y: 0, twist: 0 };
  let last = 0;

  // Baseline = average of the first BASE_SAMPLES readings (how the user is
  // holding the phone). Tilt is reported relative to this, because beta is not
  // 0-based in the way flat-holding assumes — without the offset one axis is
  // already saturated for most grips.
  const BASE_SAMPLES = 15; // ~250 ms at 60 Hz
  let sumGamma = 0;
  let sumBeta = 0;
  let samples = 0;
  let baseGamma = 0;
  let baseBeta = 0;
  let centered = false;
  let prevAlpha: number | null = null;
  let prevAlphaAt = 0;

  const handler = (e: DeviceOrientationEvent) => {
    const gamma = e.gamma ?? 0;
    const beta = e.beta ?? 0;
    const alpha = e.alpha ?? 0;

    if (!centered) {
      sumGamma += gamma;
      sumBeta += beta;
      samples += 1;
      if (samples >= BASE_SAMPLES) {
        baseGamma = sumGamma / samples;
        baseBeta = sumBeta / samples;
        centered = true;
        prevAlpha = alpha;
        prevAlphaAt = performance.now();
      }
      return; // don't emit until we have a stable center
    }

    const now = performance.now();

    // Wrist twist = alpha's rate of change, with the 360→0 wrap handled.
    if (prevAlpha !== null) {
      const dt = Math.max(1, now - prevAlphaAt) / 1000;
      const inst = wrapDeg(alpha - prevAlpha) / dt; // deg/s
      smooth.twist = smooth.twist * 0.72 + inst * 0.28;
    }
    prevAlpha = alpha;
    prevAlphaAt = now;

    if (now - last < SEND_INTERVAL_MS) return;
    last = now;
    const t = normalizeTilt(gamma - baseGamma, beta - baseBeta);
    smooth.x = smooth.x * 0.7 + t.x * 0.3;
    smooth.y = smooth.y * 0.7 + t.y * 0.3;
    onTilt({ x: smooth.x, y: smooth.y, twist: smooth.twist, gamma, beta, alpha });
  };

  window.addEventListener('deviceorientation', handler);
  return () => window.removeEventListener('deviceorientation', handler);
}
