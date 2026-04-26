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

function extractPlaylistName(obj: any, fallback: string): string {
  if (!obj || typeof obj !== 'object') return fallback;
  const t = obj.playlist_title ?? obj.playlist;
  return typeof t === 'string' && t.trim() ? t.trim() : fallback;
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
      const trimmed = raw.trim();
      const entries = parsePlaylistJson(raw);
      if (entries.length === 0) continue;
      // Extract playlist name from first raw entry
      let firstObj: any = null;
      try {
        const arr = JSON.parse(trimmed);
        firstObj = Array.isArray(arr) ? arr[0] : arr;
      } catch {
        const firstLine = trimmed.split(/\r?\n/).find((l: string) => l.trim());
        if (firstLine) try { firstObj = JSON.parse(firstLine); } catch { /* */ }
      }
      const stem = f.replace(/\.json$/i, '');
      const name = extractPlaylistName(firstObj, stem);
      playlists.push({ name, entries });
    } catch { /* skip unreadable */ }
  }
  return playlists.sort((a, b) => a.name.localeCompare(b.name));
}
