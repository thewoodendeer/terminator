"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const mpcDetector_1 = require("./mpcDetector");
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
    // Grant microphone access in renderer
    electron_1.session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(permission === 'media');
    });
    electron_1.session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
        return permission === 'media';
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
