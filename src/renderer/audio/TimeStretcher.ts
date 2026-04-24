import { SoundTouch, SimpleFilter, WebAudioBufferSource } from 'soundtouchjs';

// Pitch-preserving time stretch + time-preserving pitch shift.
// Runs SoundTouch offline against an AudioBuffer and returns a new AudioBuffer.
// `tempo` follows the existing timeStretch convention: 2.0 = twice as fast (half the length).
export async function stretchBuffer(
  ctx: BaseAudioContext,
  src: AudioBuffer,
  tempo: number,
  pitchSemitones: number,
): Promise<AudioBuffer> {
  if (Math.abs(tempo - 1) < 1e-4 && Math.abs(pitchSemitones) < 1e-4) return src;

  const source = new WebAudioBufferSource(src);
  const st = new SoundTouch();
  st.tempo = tempo;
  st.pitchSemitones = pitchSemitones;
  const filter = new SimpleFilter(source, st);

  const chunkFrames = 4096;
  const tmp = new Float32Array(chunkFrames * 2);
  const chunks: Array<{ left: Float32Array; right: Float32Array; count: number }> = [];
  let totalFrames = 0;
  let yieldCounter = 0;

  while (true) {
    const got = filter.extract(tmp, chunkFrames);
    if (got === 0) break;
    const left  = new Float32Array(got);
    const right = new Float32Array(got);
    for (let i = 0; i < got; i++) {
      left[i]  = tmp[i * 2];
      right[i] = tmp[i * 2 + 1];
    }
    chunks.push({ left, right, count: got });
    totalFrames += got;
    if (++yieldCounter >= 8) {
      yieldCounter = 0;
      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (totalFrames === 0) return src;

  const out = ctx.createBuffer(2, totalFrames, src.sampleRate);
  const leftOut  = out.getChannelData(0);
  const rightOut = out.getChannelData(1);
  let offset = 0;
  for (const c of chunks) {
    leftOut.set(c.left,  offset);
    rightOut.set(c.right, offset);
    offset += c.count;
  }
  return out;
}
