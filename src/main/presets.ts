import path from 'path';
import { promises as fsp } from 'fs';

export interface ChopPreset {
  videoId: string;
  savedAt: string;
  chops: Array<{ id: number; start: number; end: number }>;
  pads: Array<{ index: number; chopId: number | null; mode: string; pitch: number }>;
  bpm: number;
  nextChopId: number;
}

export async function savePreset(presetsDir: string, preset: ChopPreset): Promise<void> {
  await fsp.mkdir(presetsDir, { recursive: true });
  await fsp.writeFile(path.join(presetsDir, `${preset.videoId}.json`), JSON.stringify(preset, null, 2));
}

export async function loadPreset(presetsDir: string, videoId: string): Promise<ChopPreset | null> {
  try {
    const data = await fsp.readFile(path.join(presetsDir, `${videoId}.json`), 'utf8');
    return JSON.parse(data) as ChopPreset;
  } catch { return null; }
}
