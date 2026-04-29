import path from 'path';
import { promises as fsp } from 'fs';

const AUDIO_EXTS = /\.(m4a|webm|opus|mp3|aac|ogg|wav|mp4)$/i;

export interface CacheMeta {
  videoId: string;
  title: string;
  durationSec: number;
}

export interface CachedEntry {
  audioPath: string;
  meta: CacheMeta;
}

export interface PlaylistCacheStatus {
  cached: number;
  total: number;
  sizeMB: number;
}

export function extractVideoId(idOrUrl: string): string {
  if (!idOrUrl.startsWith('http')) return idOrUrl;
  try {
    const u = new URL(idOrUrl);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    return u.searchParams.get('v') ?? idOrUrl;
  } catch { return idOrUrl; }
}

export async function findCachedEntry(cacheDir: string, videoId: string): Promise<CachedEntry | null> {
  try {
    const files = await fsp.readdir(cacheDir);
    const audioFile = files.find(f => f.startsWith(videoId + '.') && AUDIO_EXTS.test(f));
    if (!audioFile) return null;
    const audioPath = path.join(cacheDir, audioFile);
    const metaPath = path.join(cacheDir, `${videoId}.json`);
    const meta: CacheMeta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    return { audioPath, meta };
  } catch { return null; }
}

export async function saveToCache(cacheDir: string, audioSrcPath: string, meta: CacheMeta): Promise<void> {
  await fsp.mkdir(cacheDir, { recursive: true });
  const ext = path.extname(audioSrcPath);
  await fsp.copyFile(audioSrcPath, path.join(cacheDir, `${meta.videoId}${ext}`));
  await fsp.writeFile(path.join(cacheDir, `${meta.videoId}.json`), JSON.stringify(meta));
}

export async function getPlaylistCacheStatus(cacheDir: string, videoIds: string[]): Promise<PlaylistCacheStatus> {
  let cached = 0;
  let totalBytes = 0;
  for (const id of videoIds) {
    const entry = await findCachedEntry(cacheDir, id);
    if (entry) {
      cached++;
      try { totalBytes += (await fsp.stat(entry.audioPath)).size; } catch { /* */ }
    }
  }
  return { cached, total: videoIds.length, sizeMB: totalBytes / (1024 * 1024) };
}

export async function deleteCachedTracks(cacheDir: string, videoIds: string[]): Promise<number> {
  let deleted = 0;
  for (const id of videoIds) {
    const entry = await findCachedEntry(cacheDir, id);
    if (entry) {
      try {
        await fsp.unlink(entry.audioPath);
        await fsp.unlink(path.join(cacheDir, `${id}.json`)).catch(() => {});
        deleted++;
      } catch { /* */ }
    }
  }
  return deleted;
}
