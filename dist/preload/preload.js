"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('terminator', {
    exportStem: (payload) => electron_1.ipcRenderer.invoke('export-stem', payload),
    exportAllStems: (stems) => electron_1.ipcRenderer.invoke('export-all-stems', stems),
});
