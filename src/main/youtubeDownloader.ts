import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

export interface YouTubeDownloadResult {
  audio: ArrayBuffer; // raw WAV bytes for renderer to decodeAudioData
  title: string;
  durationSec: number;
  videoId: string;
}

/** Locate the yt-dlp binary. We try `yt-dlp` first (PATH lookup) and fall back
 *  to the common Windows install paths. Returns the resolved command string
 *  to pass to spawn, or null if nothing's available. */
async function findYtDlp(): Promise<string | null> {
  const candidates = [
    'yt-dlp',
    'yt-dlp.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe',
  ];
  for (const c of candidates) {
    try {
      await execFileAsync(c, ['--version']);
      return c;
    } catch { /* try next */ }
  }
  return null;
}

/** Download the audio for a YouTube video ID (or full URL) as a WAV file in
 *  a temp dir, read it back as an ArrayBuffer, return alongside metadata.
 *  We re-extract title/duration from yt-dlp's --print output instead of
 *  parsing --dump-json, which is faster and less error-prone. */
export async function downloadYouTubeAudio(idOrUrl: string): Promise<YouTubeDownloadResult> {
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
    '-f', 'bestaudio',
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
  const audioExt = /\.(m4a|webm|opus|mp3|aac|ogg|wav)$/i;
  const audioFile = files.find(f => audioExt.test(f) && !f.startsWith('meta'));
  if (!audioFile) throw new Error('yt-dlp finished but no audio file produced.');
  const audioPath = path.join(tmpDir, audioFile);
  const buffer = await fsp.readFile(audioPath);

  // Best-effort cleanup
  fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  // Convert Node Buffer to ArrayBuffer that survives the IPC boundary
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

  return { audio: ab, title: title ?? id ?? 'unknown', durationSec, videoId: id ?? '' };
}
