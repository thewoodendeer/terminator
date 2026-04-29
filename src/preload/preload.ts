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
    ipcRenderer.invoke('chopper:downloadYouTube', idOrUrl) as Promise<{
      ok: boolean; cacheUrl?: string; audio?: ArrayBuffer;
      title?: string; durationSec?: number; videoId?: string; error?: string;
    }>,

  // ── Presets ───────────────────────────────────────────────────────────────
  savePreset: (preset: object) => ipcRenderer.invoke('chopper:savePreset', preset),
  loadPreset: (videoId: string) => ipcRenderer.invoke('chopper:loadPreset', videoId) as Promise<object | null>,

  // ── Playlist cache ────────────────────────────────────────────────────────
  getCacheStatus: (playlistName: string) =>
    ipcRenderer.invoke('chopper:cacheStatus', playlistName),
  downloadPlaylist: (playlistName: string) =>
    ipcRenderer.invoke('chopper:downloadPlaylist', playlistName),
  deletePlaylistCache: (playlistName: string) =>
    ipcRenderer.invoke('chopper:deletePlaylistCache', playlistName),
  onCacheProgress: (handler: (p: { playlistName: string; done: number; total: number; currentTitle: string; active: string[] }) => void): (() => void) => {
    const listener = (_e: unknown, p: { playlistName: string; done: number; total: number; currentTitle: string; active: string[] }) => handler(p);
    ipcRenderer.on('cache:progress', listener);
    return () => ipcRenderer.removeListener('cache:progress', listener);
  },
});
