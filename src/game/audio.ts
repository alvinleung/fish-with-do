// Game-side sound: short cues synthesized with Web Audio (no audio assets),
// mirroring the controller's ratchet pattern. `ensure()` must be called from a
// user gesture (browsers only unlock audio then). Everything is generated so
// nothing extra ships in the bundle.

let actx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

// Reel: a looping bandpass-noise "whirr" whose gain/frequency follow the crank.
let reelGain: GainNode | null = null;
let reelFilter: BiquadFilterNode | null = null;

function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate; // 1s of white noise, looped
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

export function ensure(): void {
  if (actx) {
    if (actx.state === 'suspended') void actx.resume();
    return;
  }
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  actx = new Ctor();
  noise = makeNoiseBuffer(actx);

  // Reel whirr (silent until setReel raises its gain).
  const reelSrc = actx.createBufferSource();
  reelSrc.buffer = noise;
  reelSrc.loop = true;
  reelFilter = actx.createBiquadFilter();
  reelFilter.type = 'bandpass';
  reelFilter.frequency.value = 1400;
  reelFilter.Q.value = 0.8;
  reelGain = actx.createGain();
  reelGain.gain.value = 0;
  reelSrc.connect(reelFilter);
  reelFilter.connect(reelGain);
  reelGain.connect(actx.destination);
  reelSrc.start();

  // Ambient water: a very quiet looping lowpass-noise wash.
  const ambSrc = actx.createBufferSource();
  ambSrc.buffer = noise;
  ambSrc.loop = true;
  const ambFilter = actx.createBiquadFilter();
  ambFilter.type = 'lowpass';
  ambFilter.frequency.value = 420;
  const ambGain = actx.createGain();
  ambGain.gain.value = 0.045;
  ambSrc.connect(ambFilter);
  ambFilter.connect(ambGain);
  ambGain.connect(actx.destination);
  ambSrc.start();
}

// 0..1 — how hard the reel is being cranked. Called every frame.
export function setReel(level: number): void {
  if (!actx || !reelGain || !reelFilter) return;
  const t = actx.currentTime;
  const g = Math.max(0, Math.min(1, level));
  reelGain.gain.setTargetAtTime(g * 0.22, t, 0.05);
  reelFilter.frequency.setTargetAtTime(900 + g * 1800, t, 0.05);
}

function blip(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number): void {
  if (!actx) return;
  const t = actx.currentTime;
  const osc = actx.createOscillator();
  const g = actx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(g);
  g.connect(actx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noiseBurst(dur: number, type: BiquadFilterType, freq: number, vol: number): void {
  if (!actx || !noise) return;
  const t = actx.currentTime;
  const src = actx.createBufferSource();
  src.buffer = noise;
  const f = actx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = 0.7;
  const g = actx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(actx.destination);
  src.start(t, Math.random() * 0.4, dur + 0.02);
}

// Line hits the water (cast landing).
export function splash(): void {
  noiseBurst(0.3, 'lowpass', 900, 0.5);
  blip(170, 0.18, 'sine', 0.28, 80);
}

// The bobber dips — the moment to strike.
export function bite(): void {
  blip(560, 0.13, 'sine', 0.4, 260);
  noiseBurst(0.12, 'bandpass', 1900, 0.25);
}

// Successful catch — a small ascending jingle.
export function catchFish(): void {
  if (!actx) return;
  [523, 659, 784, 1047].forEach((n, i) => {
    setTimeout(() => blip(n, 0.17, 'triangle', 0.34), i * 85);
  });
}

// Line snapped / got away — a dull twang.
export function lose(): void {
  blip(290, 0.42, 'sawtooth', 0.3, 70);
  noiseBurst(0.3, 'lowpass', 520, 0.3);
}
