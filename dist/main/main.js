"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const isDev = process.env.NODE_ENV !== 'production' && !electron_1.app.isPackaged;
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
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
electron_1.app.on('window-all-closed', () => {
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
