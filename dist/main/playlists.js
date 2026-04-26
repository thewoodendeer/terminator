"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPlaylists = loadPlaylists;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
/** yt-dlp --dump-json emits one JSON object per line (NDJSON). Some commits
 *  in this repo also store concatenated arrays. Parse defensively. */
function parsePlaylistJson(raw) {
    const trimmed = raw.trim();
    // Try parse as a JSON array first
    try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr))
            return arr.map(toEntry).filter(Boolean);
    }
    catch { /* not a JSON array, try NDJSON */ }
    // NDJSON
    const out = [];
    for (const line of trimmed.split(/\r?\n/)) {
        const s = line.trim();
        if (!s)
            continue;
        try {
            const obj = JSON.parse(s);
            const e = toEntry(obj);
            if (e)
                out.push(e);
        }
        catch { /* skip malformed lines */ }
    }
    return out;
}
function toEntry(obj) {
    if (!obj || typeof obj !== 'object')
        return null;
    const id = obj.id ?? obj.video_id ?? obj.url;
    if (typeof id !== 'string' || !id)
        return null;
    const title = (typeof obj.title === 'string' && obj.title) || id;
    const duration = typeof obj.duration === 'number' ? obj.duration : undefined;
    return { id, title, duration };
}
function extractPlaylistName(obj, fallback) {
    if (!obj || typeof obj !== 'object')
        return fallback;
    const t = obj.playlist_title ?? obj.playlist;
    return typeof t === 'string' && t.trim() ? t.trim() : fallback;
}
/** Read all playlist*.json files from the data directory next to the app. */
async function loadPlaylists(dataDir) {
    let files = [];
    try {
        files = await fs_1.promises.readdir(dataDir);
    }
    catch {
        return [];
    }
    const playlists = [];
    for (const f of files) {
        if (!f.endsWith('.json'))
            continue;
        const full = path_1.default.join(dataDir, f);
        try {
            const raw = await fs_1.promises.readFile(full, 'utf8');
            const trimmed = raw.trim();
            const entries = parsePlaylistJson(raw);
            if (entries.length === 0)
                continue;
            // Extract playlist name from first raw entry
            let firstObj = null;
            try {
                const arr = JSON.parse(trimmed);
                firstObj = Array.isArray(arr) ? arr[0] : arr;
            }
            catch {
                const firstLine = trimmed.split(/\r?\n/).find((l) => l.trim());
                if (firstLine)
                    try {
                        firstObj = JSON.parse(firstLine);
                    }
                    catch { /* */ }
            }
            const stem = f.replace(/\.json$/i, '');
            const name = extractPlaylistName(firstObj, stem);
            playlists.push({ name, entries });
        }
        catch { /* skip unreadable */ }
    }
    return playlists.sort((a, b) => a.name.localeCompare(b.name));
}
