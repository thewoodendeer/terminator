import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('terminator', {
  exportStem: (payload: { name: string; data: ArrayBuffer }) =>
    ipcRenderer.invoke('export-stem', payload),
  exportAllStems: (stems: Array<{ name: string; data: ArrayBuffer }>) =>
    ipcRenderer.invoke('export-all-stems', stems),
});
