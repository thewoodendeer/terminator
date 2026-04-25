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
            const entries = parsePlaylistJson(raw);
            if (entries.length > 0) {
                playlists.push({ name: f.replace(/\.json$/i, ''), entries });
            }
        }
        catch { /* skip unreadable */ }
    }
    return playlists.sort((a, b) => a.name.localeCompare(b.name));
}
