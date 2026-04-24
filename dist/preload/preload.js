"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('terminator', {
    exportStem: (payload) => electron_1.ipcRenderer.invoke('export-stem', payload),
    exportAllStems: (stems) => electron_1.ipcRenderer.invoke('export-all-stems', stems),
    exportToMpc: (stems) => electron_1.ipcRenderer.invoke('mpc:export-all', stems),
    ejectMpc: () => electron_1.ipcRenderer.invoke('mpc:eject'),
    onMpcStatus: (handler) => {
        const listener = (_e, mp) => handler(mp);
        electron_1.ipcRenderer.on('mpc:status', listener);
        return () => electron_1.ipcRenderer.removeListener('mpc:status', listener);
    },
});
