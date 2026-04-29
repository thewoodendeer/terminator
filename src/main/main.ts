import { app, BrowserWindow, ipcMain, dialog, session, protocol, net } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';
import { findMpcExportDir, ejectDriveForExportDir } from './mpcDetector';
import { downloadYouTubeAudio } from './youtubeDownloader';
import { loadPlaylists } from './playlists';
import { getPlaylistCacheStatus, deleteCachedTracks, findCachedEntry, extractVideoId } from './cache';
import { savePreset, loadPreset, ChopPreset } from './presets';

// Register before app.whenReady — lets the renderer fetch() from this scheme
protocol.registerSchemesAsPrivileged([{
  scheme: 'terminator-cache',
  privileges: { secure: true, standard: false, supportFetchAPI: true },
}]);

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'terminator-settings.json');
}

function readSettings(): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8')); } catch { return {}; }
}

function writeSettings(data: Record<string, any>): void {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2));
}

function getCacheDir(): string {
  const custom = readSettings().cacheDir;
  return (typeof custom === 'string' && custom) ? custom : path.join(app.getPath('userData'), 'terminator-audio-cache');
}

function getPresetsDir(): string {
  return path.join(app.getPath('userData'), 'terminator-presets');
}

function getDataDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'data')
    : path.join(__dirname, '..', '..', 'data');
}

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

const MPC_POLL_MS = 2000;
// Full export directory (ends in `terminator`) — resolved by the detector to
// live inside the MPC's User samples folder when possible.
let currentMpcExportDir: string | null = null;
let mpcPollTimer: NodeJS.Timeout | null = null;
// Pause the drive-detection poll while an eject is running, otherwise our own
// fs.readdir/fs.stat on the MPC root keeps a handle open and Windows refuses
// to dismount.
let ejectInProgress = false;

function broadcastMpcStatus(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.webContents.send('mpc:status', currentMpcExportDir);
}

function startMpcPolling(win: BrowserWindow): void {
  const tick = async () => {
    if (ejectInProgress) return;
    try {
      const found = await findMpcExportDir();
      if (found !== currentMpcExportDir) {
        currentMpcExportDir = found;
        broadcastMpcStatus(win);
      }
    } catch (_) { /* swallow — tick again next cycle */ }
  };
  tick();
  mpcPollTimer = setInterval(tick, MPC_POLL_MS);
}

// Keep audio processing in-process (no IPC round-trips to OS audio service)
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess,AudioServiceSandbox');
// Allow AudioContext to resume without waiting for a user gesture
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Enable Web MIDI API (blocked by default in Chromium 94+)
app.commandLine.appendSwitch('enable-features', 'WebMIDI,WebMIDIGetStatusAPI');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    titleBarStyle: 'hiddenInset',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  // Serve cached audio files directly from disk — renderer fetch()es this
  // scheme instead of receiving the raw bytes over IPC, so no serialization overhead
  protocol.handle('terminator-cache', (request) => {
    const url = new URL(request.url);
    const filename = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const filePath = path.join(getCacheDir(), filename);
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Grant microphone access in renderer
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'midi', 'midiSysex'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return ['media', 'midi', 'midiSysex'].includes(permission);
  });

  createWindow();
  const mainWin = BrowserWindow.getAllWindows()[0];
  if (mainWin) {
    // Resend current status whenever the renderer reloads (HMR / F5)
    mainWin.webContents.on('did-finish-load', () => broadcastMpcStatus(mainWin));
    startMpcPolling(mainWin);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (mpcPollTimer) { clearInterval(mpcPollTimer); mpcPollTimer = null; }
  if (process.platform !== 'darwin') app.quit();
});

// IPC: export a single stem WAV
ipcMain.handle('export-stem', async (_event, { name, data }: { name: string; data: ArrayBuffer }) => {
  const { filePath } = await dialog.showSaveDialog({
    defaultPath: `${name}.wav`,
    filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
  });
  if (!filePath) return { cancelled: true };
  fs.writeFileSync(filePath, Buffer.from(data));
  return { filePath };
});

// IPC: export all stems into a folder
ipcMain.handle('export-all-stems', async (_event, stems: Array<{ name: string; data: ArrayBuffer }>) => {
  const { filePaths } = await dialog.showOpenDialog({
    title: 'Choose export folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!filePaths || filePaths.length === 0) return { cancelled: true };
  const dir = filePaths[0];
  const saved: string[] = [];
  for (const stem of stems) {
    const out = path.join(dir, `${stem.name}.wav`);
    fs.writeFileSync(out, Buffer.from(stem.data));
    saved.push(out);
  }
  return { saved };
});

// IPC: safely eject the MPC's SD card. Fires the same "Safely Remove"
// action as the Windows taskbar tray icon.
ipcMain.handle('mpc:eject', async () => {
  if (!currentMpcExportDir) return { error: 'No MPC card detected' };
  ejectInProgress = true;
  try {
    const res = await ejectDriveForExportDir(currentMpcExportDir);
    if (res.ok) {
      // Reflect the ejected state immediately so the renderer UI updates
      // without waiting for the next detection poll.
      currentMpcExportDir = null;
      for (const w of BrowserWindow.getAllWindows()) broadcastMpcStatus(w);
    }
    return res.ok ? { ok: true } : { error: res.error };
  } finally {
    ejectInProgress = false;
  }
});

// IPC: list playlists from /data/playlist*.json
ipcMain.handle('chopper:listPlaylists', async () => loadPlaylists(getDataDir()));

// IPC: download a YouTube video's audio — cache hit returns a URL the renderer
// fetches directly (no IPC byte transfer); miss falls back to yt-dlp
ipcMain.handle('chopper:downloadYouTube', async (_event, idOrUrl: string) => {
  try {
    const cacheDir = getCacheDir();
    const videoId = extractVideoId(idOrUrl);
    const cached = await findCachedEntry(cacheDir, videoId);
    if (cached) {
      const filename = encodeURIComponent(path.basename(cached.audioPath));
      return { ok: true, cacheUrl: `terminator-cache://audio/${filename}`, ...cached.meta };
    }
    const result = await downloadYouTubeAudio(idOrUrl, cacheDir);
    return { ok: true, ...result };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

// IPC: how many tracks in this playlist are already cached + total disk size + estimated download size
ipcMain.handle('chopper:cacheStatus', async (_event, playlistName: string) => {
  const playlists = await loadPlaylists(getDataDir());
  const pl = playlists.find(p => p.name === playlistName);
  if (!pl) return { cached: 0, total: 0, sizeMB: 0, estimatedMB: 0 };
  const status = await getPlaylistCacheStatus(getCacheDir(), pl.entries.map(e => e.id));
  // Estimate uncached download size: ~1.5 MB/min at 128kbps
  const uncachedEntries = pl.entries.slice(status.cached);
  const estimatedMB = uncachedEntries.reduce((sum, e) => sum + ((e.duration ?? 180) / 60) * 1.5, 0);
  return { ...status, estimatedMB };
});

// IPC: batch-download all tracks in a playlist to local cache.
// Sends 'cache:progress' events during download so the UI can show progress.
ipcMain.handle('chopper:downloadPlaylist', async (event, playlistName: string) => {
  const playlists = await loadPlaylists(getDataDir());
  const pl = playlists.find(p => p.name === playlistName);
  if (!pl) return { ok: false, error: 'Playlist not found' };

  const entries = pl.entries;
  const total = entries.length;
  let done = 0;
  let errors = 0;
  const cacheDir = getCacheDir();
  const activeDownloads = new Set<string>(); // titles currently in-flight

  const send = (title: string) => {
    if (event.sender.isDestroyed()) return;
    event.sender.send('cache:progress', {
      playlistName, done, total,
      currentTitle: title,
      active: [...activeDownloads],
    });
  };

  const queue = [...entries];
  const worker = async () => {
    while (queue.length > 0) {
      const entry = queue.shift()!;
      const alreadyCached = !!(await findCachedEntry(cacheDir, entry.id));
      if (alreadyCached) { done++; send(entry.title); continue; }
      activeDownloads.add(entry.title);
      send(entry.title);
      try {
        await downloadYouTubeAudio(entry.id, cacheDir);
      } catch { errors++; }
      activeDownloads.delete(entry.title);
      done++;
      send(entry.title);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  return { ok: true, done, errors };
});

// IPC: save/load chop presets per video ID
ipcMain.handle('chopper:savePreset', async (_event, preset: ChopPreset) => {
  await savePreset(getPresetsDir(), preset);
  return { ok: true };
});

ipcMain.handle('chopper:loadPreset', async (_event, videoId: string) => {
  const preset = await loadPreset(getPresetsDir(), videoId);
  return preset ?? null;
});

// IPC: delete all cached tracks for a playlist
ipcMain.handle('chopper:deletePlaylistCache', async (_event, playlistName: string) => {
  const playlists = await loadPlaylists(getDataDir());
  const pl = playlists.find(p => p.name === playlistName);
  if (!pl) return { deleted: 0 };
  const deleted = await deleteCachedTracks(getCacheDir(), pl.entries.map(e => e.id));
  return { deleted };
});

// IPC: get / set the audio cache directory (supports external hard drives)
ipcMain.handle('chopper:getCacheDir', () => getCacheDir());

ipcMain.handle('chopper:setCacheDir', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    title: 'Choose audio cache folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!filePaths || filePaths.length === 0) return { cancelled: true };
  const chosen = filePaths[0];
  const settings = readSettings();
  settings.cacheDir = chosen;
  writeSettings(settings);
  return { ok: true, cacheDir: chosen };
});

// IPC: dump all stems into the detected MPC export directory (typically
// <card>/<MPC folder>/Samples/User/terminator/).
ipcMain.handle('mpc:export-all', async (_event, stems: Array<{ name: string; data: ArrayBuffer }>) => {
  if (!currentMpcExportDir) return { error: 'No MPC card detected' };
  const dir = currentMpcExportDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    return { error: `Could not create ${dir}: ${e.message}` };
  }
  const saved: string[] = [];
  for (const stem of stems) {
    const out = path.join(dir, `${stem.name}.wav`);
    try {
      fs.writeFileSync(out, Buffer.from(stem.data));
      saved.push(out);
    } catch (e: any) {
      return { error: `Failed writing ${stem.name}: ${e.message}`, partial: saved };
    }
  }
  return { savedTo: dir, saved };
});
