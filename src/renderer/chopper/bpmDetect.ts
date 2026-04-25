// Simple onset-energy BPM estimator. Decent-enough for breakbeats, lofi,
// and soul samples (the use case here). Not as good as Essentia.js but no
// WASM dep. Returns an integer BPM in [60, 200].
//
// Approach: bandpass-ish via decimation, half-wave rectify, low-pass via
// running energy, autocorrelate over a plausible BPM window, pick the lag
// with the highest correlation peak. Works offline on the AudioBuffer.
export function estimateBPM(buffer: AudioBuffer): number {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  // Step 1: decimate to a manageable rate (~6 kHz) and rectify
  const targetSr = 6000;
  const stride = Math.max(1, Math.floor(sr / targetSr));
  const decimSr = sr / stride;
  const N = Math.floor(ch.length / stride);
  const env = new Float32Array(N);
  // Running envelope (one-pole low-pass on absolute value)
  const a = 0.985;
  let lp = 0;
  for (let i = 0; i < N; i++) {
    const s = Math.abs(ch[i * stride]);
    lp = a * lp + (1 - a) * s;
    env[i] = lp;
  }
  // Step 2: differentiate to emphasize onsets, half-wave rectify
  const onset = new Float32Array(N);
  for (let i = 1; i < N; i++) {
    const d = env[i] - env[i - 1];
    onset[i] = d > 0 ? d : 0;
  }
  // Step 3: autocorrelation over 60–200 BPM
  const minBPM = 60;
  const maxBPM = 200;
  const minLag = Math.floor((60 / maxBPM) * decimSr);
  const maxLag = Math.floor((60 / minBPM) * decimSr);
  let bestLag = minLag;
  let bestCorr = -Infinity;
  // Use only the central portion to avoid bleed at the buffer edges
  const start = Math.floor(N * 0.1);
  const end = Math.floor(N * 0.9) - maxLag;
  if (end - start < decimSr * 8) return 0; // need at least ~8s of audio for a stable estimate
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = start; i < end; i++) sum += onset[i] * onset[i + lag];
    if (sum > bestCorr) { bestCorr = sum; bestLag = lag; }
  }
  if (bestCorr <= 0) return 0;
  let bpm = (60 * decimSr) / bestLag;
  // Many onset-corr methods report 0.5× or 2× the actual BPM. Snap into
  // a typical range (75–150) by halving / doubling.
  while (bpm < 75)  bpm *= 2;
  while (bpm > 160) bpm /= 2;
  return Math.round(bpm);
}
