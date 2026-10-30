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

// Starts listening to deviceorientation and calls onTilt with a lightly
// low-passed, normalized {x, y} at roughly 30 Hz. Returns a stop function.
export function startTilt(onTilt: (v: { x: number; y: number }) => void): () => void {
  let smooth = { x: 0, y: 0 };
  let last = 0;

  const handler = (e: DeviceOrientationEvent) => {
    const now = performance.now();
    if (now - last < SEND_INTERVAL_MS) return;
    last = now;
    const t = normalizeTilt(e.gamma ?? 0, e.beta ?? 0);
    smooth.x = smooth.x * 0.7 + t.x * 0.3;
    smooth.y = smooth.y * 0.7 + t.y * 0.3;
    onTilt({ x: smooth.x, y: smooth.y });
  };

  window.addEventListener('deviceorientation', handler);
  return () => window.removeEventListener('deviceorientation', handler);
}
