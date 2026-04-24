import { Track } from './Track';

export type WAVBitDepth = 8 | 16 | 24 | 32;
export type ExportFormat = 'wav' | 'mp3' | 'flac';

export interface ExportOptions {
  format: ExportFormat;
  bitDepth: WAVBitDepth;
  dry: boolean; // export without effects
}

export function encodeWAV(buf: AudioBuffer, bitDepth: WAVBitDepth = 16): ArrayBuffer {
  const numCh = buf.numberOfChannels;
  const numSamples = buf.length;
  const sr = buf.sampleRate;

  const bytesPerSample = bitDepth === 32 ? 4 : bitDepth === 24 ? 3 : bitDepth === 8 ? 1 : 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 3 = IEEE float
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const sample = buf.getChannelData(ch)[i];
      writeSample(view, offset, sample, bitDepth);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

function writeSample(view: DataView, offset: number, sample: number, bits: WAVBitDepth) {
  const clamped = Math.max(-1, Math.min(1, sample));
  switch (bits) {
    case 8:
      view.setUint8(offset, ((clamped + 1) * 127.5) | 0);
      break;
    case 16:
      view.setInt16(offset, clamped < 0 ? clamped * 32768 : clamped * 32767, true);
      break;
    case 24: {
      const val = clamped < 0 ? clamped * 8388608 : clamped * 8388607;
      const i = val | 0;
      view.setUint8(offset,     i & 0xff);
      view.setUint8(offset + 1, (i >> 8) & 0xff);
      view.setUint8(offset + 2, (i >> 16) & 0xff);
      break;
    }
    case 32:
      view.setFloat32(offset, clamped, true);
      break;
  }
}

function writeStr(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export async function exportStem(
  track: Track,
  loopDuration: number,
  opts: ExportOptions
): Promise<{ name: string; data: ArrayBuffer }> {
  if (!track.buffer) throw new Error('Track has no audio');

  let buf: AudioBuffer;

  if (opts.dry) {
    buf = track.buffer;
  } else {
    // Render through effects using OfflineAudioContext
    const sr = track.buffer.sampleRate;
    const len = Math.ceil(loopDuration * sr);
    const offCtx = new OfflineAudioContext(2, len, sr);

    const src = offCtx.createBufferSource();
    src.buffer = track.buffer;
    src.loop = true;
    src.loopEnd = track.buffer.duration;
    src.playbackRate.value = track.timeStretch;
    src.connect(offCtx.destination);
    src.start(0);

    buf = await offCtx.startRendering();
  }

  const data = encodeWAV(buf, opts.bitDepth);
  return { name: track.name.replace(/\s+/g, '_'), data };
}

export async function exportMaster(
  tracks: Track[],
  loopDuration: number,
  opts: ExportOptions
): Promise<{ name: string; data: ArrayBuffer }> {
  const sr = tracks[0]?.buffer?.sampleRate ?? 44100;
  const len = Math.ceil(loopDuration * sr);
  const offCtx = new OfflineAudioContext(2, len, sr);

  for (const track of tracks) {
    if (!track.buffer || track.muted) continue;
    const src = offCtx.createBufferSource();
    src.buffer = track.buffer;
    src.loop = true;
    src.loopEnd = track.buffer.duration;
    src.playbackRate.value = track.timeStretch;

    const gain = offCtx.createGain();
    gain.gain.value = track.volume;
    const pan = offCtx.createStereoPanner();
    pan.pan.value = track.pan;

    src.connect(gain);
    gain.connect(pan);
    pan.connect(offCtx.destination);
    src.start(0);
  }

  const buf = await offCtx.startRendering();
  const data = encodeWAV(buf, opts.bitDepth);
  return { name: 'MASTER', data };
}
