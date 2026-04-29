"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractVideoId = extractVideoId;
exports.findCachedEntry = findCachedEntry;
exports.saveToCache = saveToCache;
exports.getPlaylistCacheStatus = getPlaylistCacheStatus;
exports.deleteCachedTracks = deleteCachedTracks;
const path_1 = __importDefault(require("path"));
const fs_1 = require("fs");
const AUDIO_EXTS = /\.(m4a|webm|opus|mp3|aac|ogg|wav|mp4)$/i;
function extractVideoId(idOrUrl) {
    if (!idOrUrl.startsWith('http'))
        return idOrUrl;
    try {
        const u = new URL(idOrUrl);
        if (u.hostname === 'youtu.be')
            return u.pathname.slice(1).split('?')[0];
        return u.searchParams.get('v') ?? idOrUrl;
    }
    catch {
        return idOrUrl;
    }
}
async function findCachedEntry(cacheDir, videoId) {
    try {
        const files = await fs_1.promises.readdir(cacheDir);
        const audioFile = files.find(f => f.startsWith(videoId + '.') && AUDIO_EXTS.test(f));
        if (!audioFile)
            return null;
        const audioPath = path_1.default.join(cacheDir, audioFile);
        const metaPath = path_1.default.join(cacheDir, `${videoId}.json`);
        const meta = JSON.parse(await fs_1.promises.readFile(metaPath, 'utf8'));
        return { audioPath, meta };
    }
    catch {
        return null;
    }
}
async function saveToCache(cacheDir, audioSrcPath, meta) {
    await fs_1.promises.mkdir(cacheDir, { recursive: true });
    const ext = path_1.default.extname(audioSrcPath);
    await fs_1.promises.copyFile(audioSrcPath, path_1.default.join(cacheDir, `${meta.videoId}${ext}`));
    await fs_1.promises.writeFile(path_1.default.join(cacheDir, `${meta.videoId}.json`), JSON.stringify(meta));
}
async function getPlaylistCacheStatus(cacheDir, videoIds) {
    let cached = 0;
    let totalBytes = 0;
    for (const id of videoIds) {
        const entry = await findCachedEntry(cacheDir, id);
        if (entry) {
            cached++;
            try {
                totalBytes += (await fs_1.promises.stat(entry.audioPath)).size;
            }
            catch { /* */ }
        }
    }
    return { cached, total: videoIds.length, sizeMB: totalBytes / (1024 * 1024) };
}
async function deleteCachedTracks(cacheDir, videoIds) {
    let deleted = 0;
    for (const id of videoIds) {
        const entry = await findCachedEntry(cacheDir, id);
        if (entry) {
            try {
                await fs_1.promises.unlink(entry.audioPath);
                await fs_1.promises.unlink(path_1.default.join(cacheDir, `${id}.json`)).catch(() => { });
                deleted++;
            }
            catch { /* */ }
        }
    }
    return deleted;
}
