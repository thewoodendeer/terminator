import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { extractVideoId, findCachedEntry, saveToCache } from './cache';

const execFileAsync = promisify(execFile);

export interface YouTubeDownloadResult {
  audio: ArrayBuffer; // raw WAV bytes for renderer to decodeAudioData
  title: string;
  durationSec: number;
  videoId: string;
}

let cachedYtDlp: string | null | undefined = undefined; // undefined = not yet resolved

/** Locate the yt-dlp binary. We try `yt-dlp` first (PATH lookup) and fall back
 *  to the common Windows install paths. Returns the resolved command string
 *  to pass to spawn, or null if nothing's available. Result is cached for the
 *  lifetime of the process so we don't re-probe on every download. */
async function findYtDlp(): Promise<string | null> {
  if (cachedYtDlp !== undefined) return cachedYtDlp;
  const home = os.homedir();
  const candidates: string[] = [
    'yt-dlp',
    'yt-dlp.exe',
    path.join(home, 'Library', 'Python', '3.13', 'bin', 'yt-dlp'),
    path.join(home, 'Library', 'Python', '3.12', 'bin', 'yt-dlp'),
    path.join(home, 'Library', 'Python', '3.11', 'bin', 'yt-dlp'),
    path.join(home, 'Library', 'Python', '3.10', 'bin', 'yt-dlp'),
    path.join(home, 'Library', 'Python', '3.9', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
    path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
    path.join(home, 'scoop', 'shims', 'yt-dlp.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe',
  ];
  for (const c of candidates) {
    try {
      await execFileAsync(c, ['--version']);
      cachedYtDlp = c;
      return c;
    } catch { /* try next */ }
  }
  // Last-resort fallback: WinGet user-scope sometimes installs without
  // creating a symlink in Links/. Scan the Packages dir for the actual exe.
  try {
    const pkgRoot = path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
    const entries = await fsp.readdir(pkgRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || !/^yt-dlp/i.test(e.name)) continue;
      const probe = path.join(pkgRoot, e.name, 'yt-dlp.exe');
      try {
        await execFileAsync(probe, ['--version']);
        cachedYtDlp = probe;
        return probe;
      } catch { /* try next */ }
    }
  } catch { /* WinGet not present */ }
  cachedYtDlp = null;
  return null;
}

/** Download the audio for a YouTube video ID (or full URL).
 *  If cacheDir is provided, checks disk cache first (instant return) and
 *  saves newly-downloaded files to cache for future fast loads. */
export async function downloadYouTubeAudio(idOrUrl: string, cacheDir?: string): Promise<YouTubeDownloadResult> {
  // Cache hit — return instantly without hitting YouTube
  if (cacheDir) {
    const videoId = extractVideoId(idOrUrl);
    const cached = await findCachedEntry(cacheDir, videoId);
    if (cached) {
      const buf = await fsp.readFile(cached.audioPath);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      return { audio: ab, ...cached.meta };
    }
  }
  const ytdlp = await findYtDlp();
  if (!ytdlp) {
    throw new Error("yt-dlp not found. Install with `winget install yt-dlp` or `choco install yt-dlp`, then restart the app.");
  }

  const url = idOrUrl.startsWith('http') ? idOrUrl : `https://www.youtube.com/watch?v=${idOrUrl}`;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'terminator-yt-'));
  const outTemplate = path.join(tmpDir, '%(id)s.%(ext)s');

  // Grab the best audio-only stream (typically .m4a/aac or .webm/opus) and
  // hand it to the renderer. Browser decodeAudioData handles both natively,
  // so we don't need ffmpeg for a remux to WAV. --no-playlist prevents mix
  // URL expansion. --print-to-file captures metadata in one pass.
  const metaFile = path.join(tmpDir, 'meta.txt');
  const args = [
    url,
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
    '--extractor-args', 'youtube:player_client=android,web',
    '--concurrent-fragments', '4',
    '--no-playlist',
    '--no-progress',
    '-o', outTemplate,
    '--print-to-file', `%(id)s\t%(title)s\t%(duration)s`, metaFile,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ytdlp, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });

  // Read metadata
  const metaRaw = await fsp.readFile(metaFile, 'utf8');
  const [id, title, durationStr] = metaRaw.trim().split('\t');
  const durationSec = Number(durationStr) || 0;

  // Find the produced audio file (could be .m4a, .webm, .opus, .mp3)
  const files = await fsp.readdir(tmpDir);
  const audioExt = /\.(m4a|webm|opus|mp3|aac|ogg|wav|mp4)$/i;
  const audioFile = files.find(f => audioExt.test(f) && !f.startsWith('meta'));
  if (!audioFile) throw new Error('yt-dlp finished but no audio file produced.');
  const audioPath = path.join(tmpDir, audioFile);
  const buffer = await fsp.readFile(audioPath);

  // Save to cache before cleanup
  if (cacheDir) {
    saveToCache(cacheDir, audioPath, { videoId: id, title: title ?? id ?? 'unknown', durationSec }).catch(() => {});
  }

  // Best-effort cleanup
  fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  // Convert Node Buffer to ArrayBuffer that survives the IPC boundary
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

  return { audio: ab, title: title ?? id ?? 'unknown', durationSec, videoId: id ?? '' };
}
