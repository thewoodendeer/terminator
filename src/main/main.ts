import { app, BrowserWindow, ipcMain, dialog, session } from 'electron';
import path from 'path';
import fs from 'fs';

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
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
