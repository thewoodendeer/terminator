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
const cache_1 = require("./cache");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
let cachedYtDlp = undefined; // undefined = not yet resolved
/** Locate the yt-dlp binary. We try `yt-dlp` first (PATH lookup) and fall back
 *  to the common Windows install paths. Returns the resolved command string
 *  to pass to spawn, or null if nothing's available. Result is cached for the
 *  lifetime of the process so we don't re-probe on every download. */
async function findYtDlp() {
    if (cachedYtDlp !== undefined)
        return cachedYtDlp;
    const home = os_1.default.homedir();
    const candidates = [
        'yt-dlp',
        'yt-dlp.exe',
        path_1.default.join(home, 'Library', 'Python', '3.13', 'bin', 'yt-dlp'),
        path_1.default.join(home, 'Library', 'Python', '3.12', 'bin', 'yt-dlp'),
        path_1.default.join(home, 'Library', 'Python', '3.11', 'bin', 'yt-dlp'),
        path_1.default.join(home, 'Library', 'Python', '3.10', 'bin', 'yt-dlp'),
        path_1.default.join(home, 'Library', 'Python', '3.9', 'bin', 'yt-dlp'),
        '/usr/local/bin/yt-dlp',
        '/opt/homebrew/bin/yt-dlp',
        path_1.default.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
        path_1.default.join(home, 'scoop', 'shims', 'yt-dlp.exe'),
        'C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe',
    ];
    for (const c of candidates) {
        try {
            await execFileAsync(c, ['--version']);
            cachedYtDlp = c;
            return c;
        }
        catch { /* try next */ }
    }
    // Last-resort fallback: WinGet user-scope sometimes installs without
    // creating a symlink in Links/. Scan the Packages dir for the actual exe.
    try {
        const pkgRoot = path_1.default.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
        const entries = await fs_1.promises.readdir(pkgRoot, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory() || !/^yt-dlp/i.test(e.name))
                continue;
            const probe = path_1.default.join(pkgRoot, e.name, 'yt-dlp.exe');
            try {
                await execFileAsync(probe, ['--version']);
                cachedYtDlp = probe;
                return probe;
            }
            catch { /* try next */ }
        }
    }
    catch { /* WinGet not present */ }
    cachedYtDlp = null;
    return null;
}
/** Download the audio for a YouTube video ID (or full URL).
 *  If cacheDir is provided, checks disk cache first (instant return) and
 *  saves newly-downloaded files to cache for future fast loads. */
async function downloadYouTubeAudio(idOrUrl, cacheDir) {
    // Cache hit — return instantly without hitting YouTube
    if (cacheDir) {
        const videoId = (0, cache_1.extractVideoId)(idOrUrl);
        const cached = await (0, cache_1.findCachedEntry)(cacheDir, videoId);
        if (cached) {
            const buf = await fs_1.promises.readFile(cached.audioPath);
            const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            return { audio: ab, ...cached.meta };
        }
    }
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
        '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
        '--extractor-args', 'youtube:player_client=android,web',
        '--concurrent-fragments', '4',
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
    const audioExt = /\.(m4a|webm|opus|mp3|aac|ogg|wav|mp4)$/i;
    const audioFile = files.find(f => audioExt.test(f) && !f.startsWith('meta'));
    if (!audioFile)
        throw new Error('yt-dlp finished but no audio file produced.');
    const audioPath = path_1.default.join(tmpDir, audioFile);
    const buffer = await fs_1.promises.readFile(audioPath);
    // Save to cache before cleanup
    if (cacheDir) {
        (0, cache_1.saveToCache)(cacheDir, audioPath, { videoId: id, title: title ?? id ?? 'unknown', durationSec }).catch(() => { });
    }
    // Best-effort cleanup
    fs_1.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    // Convert Node Buffer to ArrayBuffer that survives the IPC boundary
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return { audio: ab, title: title ?? id ?? 'unknown', durationSec, videoId: id ?? '' };
}
