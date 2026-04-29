"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const fs_1 = __importDefault(require("fs"));
const mpcDetector_1 = require("./mpcDetector");
const youtubeDownloader_1 = require("./youtubeDownloader");
const playlists_1 = require("./playlists");
const cache_1 = require("./cache");
// Register before app.whenReady — lets the renderer fetch() from this scheme
electron_1.protocol.registerSchemesAsPrivileged([{
        scheme: 'terminator-cache',
        privileges: { secure: true, standard: false, supportFetchAPI: true },
    }]);
function getCacheDir() {
    return path_1.default.join(electron_1.app.getPath('userData'), 'terminator-audio-cache');
}
function getDataDir() {
    return electron_1.app.isPackaged
        ? path_1.default.join(process.resourcesPath, 'data')
        : path_1.default.join(__dirname, '..', '..', 'data');
}
const isDev = process.env.NODE_ENV !== 'production' && !electron_1.app.isPackaged;
const MPC_POLL_MS = 2000;
// Full export directory (ends in `terminator`) — resolved by the detector to
// live inside the MPC's User samples folder when possible.
let currentMpcExportDir = null;
let mpcPollTimer = null;
// Pause the drive-detection poll while an eject is running, otherwise our own
// fs.readdir/fs.stat on the MPC root keeps a handle open and Windows refuses
// to dismount.
let ejectInProgress = false;
function broadcastMpcStatus(win) {
    if (!win.isDestroyed())
        win.webContents.send('mpc:status', currentMpcExportDir);
}
function startMpcPolling(win) {
    const tick = async () => {
        if (ejectInProgress)
            return;
        try {
            const found = await (0, mpcDetector_1.findMpcExportDir)();
            if (found !== currentMpcExportDir) {
                currentMpcExportDir = found;
                broadcastMpcStatus(win);
            }
        }
        catch (_) { /* swallow — tick again next cycle */ }
    };
    tick();
    mpcPollTimer = setInterval(tick, MPC_POLL_MS);
}
// Keep audio processing in-process (no IPC round-trips to OS audio service)
electron_1.app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess,AudioServiceSandbox');
// Allow AudioContext to resume without waiting for a user gesture
electron_1.app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Enable Web MIDI API (blocked by default in Chromium 94+)
electron_1.app.commandLine.appendSwitch('enable-features', 'WebMIDI,WebMIDIGetStatusAPI');
function createWindow() {
    const win = new electron_1.BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#0a0a0a',
        titleBarStyle: 'hiddenInset',
        frame: false,
        webPreferences: {
            preload: path_1.default.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    if (isDev) {
        win.loadURL('http://localhost:5173');
        win.webContents.openDevTools({ mode: 'detach' });
    }
    else {
        win.loadFile(path_1.default.join(__dirname, '../renderer/index.html'));
    }
    win.setMenuBarVisibility(false);
}
electron_1.app.whenReady().then(() => {
    // Serve cached audio files directly from disk — renderer fetch()es this
    // scheme instead of receiving the raw bytes over IPC, so no serialization overhead
    electron_1.protocol.handle('terminator-cache', (request) => {
        const url = new URL(request.url);
        const filename = decodeURIComponent(url.pathname.replace(/^\//, ''));
        const filePath = path_1.default.join(getCacheDir(), filename);
        return electron_1.net.fetch((0, url_1.pathToFileURL)(filePath).toString());
    });
    // Grant microphone access in renderer
    electron_1.session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(['media', 'midi', 'midiSysex'].includes(permission));
    });
    electron_1.session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
        return ['media', 'midi', 'midiSysex'].includes(permission);
    });
    createWindow();
    const mainWin = electron_1.BrowserWindow.getAllWindows()[0];
    if (mainWin) {
        // Resend current status whenever the renderer reloads (HMR / F5)
        mainWin.webContents.on('did-finish-load', () => broadcastMpcStatus(mainWin));
        startMpcPolling(mainWin);
    }
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
electron_1.app.on('window-all-closed', () => {
    if (mpcPollTimer) {
        clearInterval(mpcPollTimer);
        mpcPollTimer = null;
    }
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
// IPC: export a single stem WAV
electron_1.ipcMain.handle('export-stem', async (_event, { name, data }) => {
    const { filePath } = await electron_1.dialog.showSaveDialog({
        defaultPath: `${name}.wav`,
        filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    });
    if (!filePath)
        return { cancelled: true };
    fs_1.default.writeFileSync(filePath, Buffer.from(data));
    return { filePath };
});
// IPC: export all stems into a folder
electron_1.ipcMain.handle('export-all-stems', async (_event, stems) => {
    const { filePaths } = await electron_1.dialog.showOpenDialog({
        title: 'Choose export folder',
        properties: ['openDirectory', 'createDirectory'],
    });
    if (!filePaths || filePaths.length === 0)
        return { cancelled: true };
    const dir = filePaths[0];
    const saved = [];
    for (const stem of stems) {
        const out = path_1.default.join(dir, `${stem.name}.wav`);
        fs_1.default.writeFileSync(out, Buffer.from(stem.data));
        saved.push(out);
    }
    return { saved };
});
// IPC: safely eject the MPC's SD card. Fires the same "Safely Remove"
// action as the Windows taskbar tray icon.
electron_1.ipcMain.handle('mpc:eject', async () => {
    if (!currentMpcExportDir)
        return { error: 'No MPC card detected' };
    ejectInProgress = true;
    try {
        const res = await (0, mpcDetector_1.ejectDriveForExportDir)(currentMpcExportDir);
        if (res.ok) {
            // Reflect the ejected state immediately so the renderer UI updates
            // without waiting for the next detection poll.
            currentMpcExportDir = null;
            for (const w of electron_1.BrowserWindow.getAllWindows())
                broadcastMpcStatus(w);
        }
        return res.ok ? { ok: true } : { error: res.error };
    }
    finally {
        ejectInProgress = false;
    }
});
// IPC: list playlists from /data/playlist*.json
electron_1.ipcMain.handle('chopper:listPlaylists', async () => (0, playlists_1.loadPlaylists)(getDataDir()));
// IPC: download a YouTube video's audio — cache hit returns a URL the renderer
// fetches directly (no IPC byte transfer); miss falls back to yt-dlp
electron_1.ipcMain.handle('chopper:downloadYouTube', async (_event, idOrUrl) => {
    try {
        const cacheDir = getCacheDir();
        const videoId = (0, cache_1.extractVideoId)(idOrUrl);
        const cached = await (0, cache_1.findCachedEntry)(cacheDir, videoId);
        if (cached) {
            const filename = encodeURIComponent(path_1.default.basename(cached.audioPath));
            return { ok: true, cacheUrl: `terminator-cache://audio/${filename}`, ...cached.meta };
        }
        const result = await (0, youtubeDownloader_1.downloadYouTubeAudio)(idOrUrl, cacheDir);
        return { ok: true, ...result };
    }
    catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
    }
});
// IPC: how many tracks in this playlist are already cached + total disk size
electron_1.ipcMain.handle('chopper:cacheStatus', async (_event, playlistName) => {
    const playlists = await (0, playlists_1.loadPlaylists)(getDataDir());
    const pl = playlists.find(p => p.name === playlistName);
    if (!pl)
        return { cached: 0, total: 0, sizeMB: 0 };
    return (0, cache_1.getPlaylistCacheStatus)(getCacheDir(), pl.entries.map(e => e.id));
});
// IPC: batch-download all tracks in a playlist to local cache.
// Sends 'cache:progress' events during download so the UI can show progress.
electron_1.ipcMain.handle('chopper:downloadPlaylist', async (event, playlistName) => {
    const playlists = await (0, playlists_1.loadPlaylists)(getDataDir());
    const pl = playlists.find(p => p.name === playlistName);
    if (!pl)
        return { ok: false, error: 'Playlist not found' };
    const entries = pl.entries;
    const total = entries.length;
    let done = 0;
    let errors = 0;
    const cacheDir = getCacheDir();
    const activeDownloads = new Set(); // titles currently in-flight
    const send = (title) => {
        if (event.sender.isDestroyed())
            return;
        event.sender.send('cache:progress', {
            playlistName, done, total,
            currentTitle: title,
            active: [...activeDownloads],
        });
    };
    const queue = [...entries];
    const worker = async () => {
        while (queue.length > 0) {
            const entry = queue.shift();
            const alreadyCached = !!(await (0, cache_1.findCachedEntry)(cacheDir, entry.id));
            if (!alreadyCached) {
                activeDownloads.add(entry.title);
                send(entry.title);
            }
            try {
                await (0, youtubeDownloader_1.downloadYouTubeAudio)(entry.id, cacheDir);
            }
            catch {
                errors++;
            }
            activeDownloads.delete(entry.title);
            done++;
            send(entry.title);
        }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    return { ok: true, done, errors };
});
// IPC: delete all cached tracks for a playlist
electron_1.ipcMain.handle('chopper:deletePlaylistCache', async (_event, playlistName) => {
    const playlists = await (0, playlists_1.loadPlaylists)(getDataDir());
    const pl = playlists.find(p => p.name === playlistName);
    if (!pl)
        return { deleted: 0 };
    const deleted = await (0, cache_1.deleteCachedTracks)(getCacheDir(), pl.entries.map(e => e.id));
    return { deleted };
});
// IPC: dump all stems into the detected MPC export directory (typically
// <card>/<MPC folder>/Samples/User/terminator/).
electron_1.ipcMain.handle('mpc:export-all', async (_event, stems) => {
    if (!currentMpcExportDir)
        return { error: 'No MPC card detected' };
    const dir = currentMpcExportDir;
    try {
        fs_1.default.mkdirSync(dir, { recursive: true });
    }
    catch (e) {
        return { error: `Could not create ${dir}: ${e.message}` };
    }
    const saved = [];
    for (const stem of stems) {
        const out = path_1.default.join(dir, `${stem.name}.wav`);
        try {
            fs_1.default.writeFileSync(out, Buffer.from(stem.data));
            saved.push(out);
        }
        catch (e) {
            return { error: `Failed writing ${stem.name}: ${e.message}`, partial: saved };
        }
    }
    return { savedTo: dir, saved };
});
