import { promises as fsp } from 'fs';
import path from 'path';

export interface PlaylistEntry {
  id: string;        // YouTube video id
  title: string;
  duration?: number; // seconds, when available
}

export interface Playlist {
  name: string;     // file stem, e.g. "playlist1"
  entries: PlaylistEntry[];
}

/** yt-dlp --dump-json emits one JSON object per line (NDJSON). Some commits
 *  in this repo also store concatenated arrays. Parse defensively. */
function parsePlaylistJson(raw: string): PlaylistEntry[] {
  const trimmed = raw.trim();
  // Try parse as a JSON array first
  try {
    const arr = JSON.parse(trimmed);
    if (Array.isArray(arr)) return arr.map(toEntry).filter(Boolean) as PlaylistEntry[];
  } catch { /* not a JSON array, try NDJSON */ }

  // NDJSON
  const out: PlaylistEntry[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      const e = toEntry(obj);
      if (e) out.push(e);
    } catch { /* skip malformed lines */ }
  }
  return out;
}

function toEntry(obj: any): PlaylistEntry | null {
  if (!obj || typeof obj !== 'object') return null;
  const id = obj.id ?? obj.video_id ?? obj.url;
  if (typeof id !== 'string' || !id) return null;
  const title = (typeof obj.title === 'string' && obj.title) || id;
  const duration = typeof obj.duration === 'number' ? obj.duration : undefined;
  return { id, title, duration };
}

/** Read all playlist*.json files from the data directory next to the app. */
export async function loadPlaylists(dataDir: string): Promise<Playlist[]> {
  let files: string[] = [];
  try { files = await fsp.readdir(dataDir); }
  catch { return []; }

  const playlists: Playlist[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dataDir, f);
    try {
      const raw = await fsp.readFile(full, 'utf8');
      const entries = parsePlaylistJson(raw);
      if (entries.length > 0) {
        playlists.push({ name: f.replace(/\.json$/i, ''), entries });
      }
    } catch { /* skip unreadable */ }
  }
  return playlists.sort((a, b) => a.name.localeCompare(b.name));
}
