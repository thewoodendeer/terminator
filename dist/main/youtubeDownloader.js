"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadYouTubeAudio = downloadYouTubeAudio;
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/** Locate the yt-dlp binary. We try `yt-dlp` first (PATH lookup) and fall back
 *  to the common Windows install paths. Returns the resolved command string
 *  to pass to spawn, or null if nothing's available. */
async function findYtDlp() {
    const candidates = [
        'yt-dlp',
        'yt-dlp.exe',
        path_1.default.join(os_1.default.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
        'C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe',
    ];
    for (const c of candidates) {
        try {
            await execFileAsync(c, ['--version']);
            return c;
        }
        catch { /* try next */ }
    }
    return null;
}
/** Download the audio for a YouTube video ID (or full URL) as a WAV file in
 *  a temp dir, read it back as an ArrayBuffer, return alongside metadata.
 *  We re-extract title/duration from yt-dlp's --print output instead of
 *  parsing --dump-json, which is faster and less error-prone. */
async function downloadYouTubeAudio(idOrUrl) {
    const ytdlp = await findYtDlp();
    if (!ytdlp) {
        throw new Error("yt-dlp not found. Install with `winget install yt-dlp` or `choco install yt-dlp`, then restart the app.");
    }
    const url = idOrUrl.startsWith('http') ? idOrUrl : `https://www.youtube.com/watch?v=${idOrUrl}`;
    const tmpDir = await fs_1.promises.mkdtemp(path_1.default.join(os_1.default.tmpdir(), 'terminator-yt-'));
    const outTemplate = path_1.default.join(tmpDir, '%(id)s.%(ext)s');
    // Grab the best audio-only stream (typically .m4a/aac or .webm/opus) and
    // hand it to the renderer. Browser decodeAudioData handles both natively,
    // so we don't need ffmpeg for a remux to WAV. --no-playlist prevents mix
    // URL expansion. --print-to-file captures metadata in one pass.
    const metaFile = path_1.default.join(tmpDir, 'meta.txt');
    const args = [
        url,
        '-f', 'bestaudio',
        '--no-playlist',
        '--no-progress',
        '-o', outTemplate,
        '--print-to-file', `%(id)s\t%(title)s\t%(duration)s`, metaFile,
    ];
    await new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(ytdlp, args, { windowsHide: true });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`yt-dlp exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
        });
    });
    // Read metadata
    const metaRaw = await fs_1.promises.readFile(metaFile, 'utf8');
    const [id, title, durationStr] = metaRaw.trim().split('\t');
    const durationSec = Number(durationStr) || 0;
    // Find the produced audio file (could be .m4a, .webm, .opus, .mp3)
    const files = await fs_1.promises.readdir(tmpDir);
    const audioExt = /\.(m4a|webm|opus|mp3|aac|ogg|wav)$/i;
    const audioFile = files.find(f => audioExt.test(f) && !f.startsWith('meta'));
    if (!audioFile)
        throw new Error('yt-dlp finished but no audio file produced.');
    const audioPath = path_1.default.join(tmpDir, audioFile);
    const buffer = await fs_1.promises.readFile(audioPath);
    // Best-effort cleanup
    fs_1.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    // Convert Node Buffer to ArrayBuffer that survives the IPC boundary
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return { audio: ab, title: title ?? id ?? 'unknown', durationSec, videoId: id ?? '' };
}
