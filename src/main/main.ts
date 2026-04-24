import { app, BrowserWindow, ipcMain, dialog, session } from 'electron';
import path from 'path';
import fs from 'fs';
import { findMpcExportDir, ejectDriveForExportDir } from './mpcDetector';

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
  // Grant microphone access in renderer
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media';
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
