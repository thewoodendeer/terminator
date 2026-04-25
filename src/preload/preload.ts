import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('terminator', {
  exportStem: (payload: { name: string; data: ArrayBuffer }) =>
    ipcRenderer.invoke('export-stem', payload),
  exportAllStems: (stems: Array<{ name: string; data: ArrayBuffer }>) =>
    ipcRenderer.invoke('export-all-stems', stems),
  exportToMpc: (stems: Array<{ name: string; data: ArrayBuffer }>) =>
    ipcRenderer.invoke('mpc:export-all', stems),
  ejectMpc: () => ipcRenderer.invoke('mpc:eject'),
  onMpcStatus: (handler: (mountpoint: string | null) => void): (() => void) => {
    const listener = (_e: unknown, mp: string | null) => handler(mp);
    ipcRenderer.on('mpc:status', listener);
    return () => ipcRenderer.removeListener('mpc:status', listener);
  },

  // ── Chopper feature ───────────────────────────────────────────────────────
  listPlaylists: () => ipcRenderer.invoke('chopper:listPlaylists'),
  downloadYouTube: (idOrUrl: string) =>
    ipcRenderer.invoke('chopper:downloadYouTube', idOrUrl),
});
