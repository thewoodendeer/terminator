import { useEffect, useRef, useState } from 'react';
import { ChopperEngine, ChopperState, CompressorStyle } from './ChopperEngine';
import { PadGrid } from './PadGrid';
import { WaveformView } from './WaveformView';
import { MasterFXPanel } from './MasterFXPanel';
import { Timeline } from './Timeline';
import { estimateBPM } from './bpmDetect';

const ipc = (window as any).terminator as {
  listPlaylists: () => Promise<Array<{ name: string; entries: Array<{ id: string; title: string; duration?: number }> }>>;
  downloadYouTube: (idOrUrl: string) => Promise<{ ok: boolean; audio?: ArrayBuffer; title?: string; durationSec?: number; videoId?: string; error?: string }>;
  exportStem: (p: { name: string; data: ArrayBuffer }) => Promise<any>;
  exportAllStems: (stems: Array<{ name: string; data: ArrayBuffer }>) => Promise<any>;
  exportToMpc: (stems: Array<{ name: string; data: ArrayBuffer }>) => Promise<{ savedTo?: string; saved?: string[]; error?: string }>;
  ejectMpc: () => Promise<{ ok?: true; error?: string }>;
  onMpcStatus: (handler: (mountpoint: string | null) => void) => () => void;
} | undefined;

type Playlist = { name: string; entries: Array<{ id: string; title: string; duration?: number }> };

export function ChopperView() {
  const engineRef = useRef<ChopperEngine | null>(null);
  if (!engineRef.current) engineRef.current = new ChopperEngine();
  const engine = engineRef.current!;

  const [state, setState] = useState<ChopperState>(() => engine.getState());
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [mpcExportDir, setMpcExportDir] = useState<string | null>(null);

  // Subscribe to engine state
  useEffect(() => {
    const unsub = engine.subscribe(setState);
    return () => { unsub(); };
  }, [engine]);

  // Load playlists once
  useEffect(() => {
    if (!ipc?.listPlaylists) return;
    ipc.listPlaylists().then(pls => {
      setPlaylists(pls);
      if (pls.length > 0) setSelectedPlaylist(pls[0].name);
    });
  }, []);

  // MPC status
  useEffect(() => {
    if (!ipc?.onMpcStatus) return;
    return ipc.onMpcStatus(setMpcExportDir);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => { engine.dispose(); };
  }, [engine]);

  const flash = (msg: string, ms = 4000) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(s => (s === msg ? null : s)), ms);
  };

  const loadRandomFromPlaylist = async () => {
    if (!ipc?.downloadYouTube) { setError('IPC unavailable'); return; }
    const pl = playlists.find(p => p.name === selectedPlaylist);
    if (!pl || pl.entries.length === 0) { setError('Playlist is empty'); return; }
    setError(null);
    engine.setLoading(true);
    flash('Pulling sample…');
    const pick = pl.entries[Math.floor(Math.random() * pl.entries.length)];
    try {
      const res = await ipc.downloadYouTube(pick.id);
      if (!res.ok || !res.audio) { setError(res.error ?? 'Download failed'); engine.setLoading(false); return; }
      await engine.loadFromArrayBuffer(res.audio, res.title ?? pick.title);
      // Detect BPM in background
      if (engine.buffer) {
        const bpm = estimateBPM(engine.buffer);
        if (bpm > 0) engine.setBpm(bpm);
      }
      flash(`Loaded: ${res.title ?? pick.title}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      engine.setLoading(false);
    }
  };

  const loadCustomUrl = async (url: string) => {
    if (!ipc?.downloadYouTube) { setError('IPC unavailable'); return; }
    if (!url.trim()) return;
    setError(null);
    engine.setLoading(true);
    flash('Pulling sample…');
    try {
      const res = await ipc.downloadYouTube(url.trim());
      if (!res.ok || !res.audio) { setError(res.error ?? 'Download failed'); engine.setLoading(false); return; }
      await engine.loadFromArrayBuffer(res.audio, res.title ?? 'untitled');
      if (engine.buffer) {
        const bpm = estimateBPM(engine.buffer);
        if (bpm > 0) engine.setBpm(bpm);
      }
      flash(`Loaded: ${res.title ?? 'untitled'}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      engine.setLoading(false);
    }
  };

  // Pad interactions
  const onPadTrigger = (idx: number, vel = 1) => {
    if (state.selectedPad !== null) {
      // Assignment mode: triggering re-selects to clear it; let user explicitly Esc to deselect
    }
    engine.triggerPad(idx, vel);
  };
  const onPadRelease = (idx: number) => engine.releasePad(idx);
  const onPadSelect = (idx: number) => engine.selectPad(state.selectedPad === idx ? null : idx);
  const onPadToggleMode = (idx: number) => engine.togglePadMode(idx);
  const onPadClear = (idx: number) => engine.clearPad(idx);

  // Click on a chop region: if a pad is selected, assign it; else preview.
  const onSeekChop = (chopId: number) => {
    if (state.selectedPad !== null) {
      engine.assignChopToPad(state.selectedPad, chopId);
      engine.selectPad(null);
    } else {
      // Preview: ad-hoc trigger via a temp pad-style playback. Find a pad that
      // has this chop assigned, or just play the chop directly.
      const pad = state.pads.find(p => p.chopId === chopId);
      if (pad) engine.triggerPad(pad.index);
    }
  };

  // Esc to deselect
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') engine.selectPad(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

  // ── Export handlers ────────────────────────────────────────────────────────
  const handleExportMaster = async () => {
    if (!state.hasBuffer) return;
    flash('Rendering master…');
    try {
      const stem = await engine.exportMaster(24);
      if (mpcExportDir && ipc?.exportToMpc) {
        const r = await ipc.exportToMpc([stem]);
        flash(r.error ? `ERR: ${r.error}` : `SAVED → ${r.savedTo}`);
      } else if (ipc?.exportStem) {
        await ipc.exportStem(stem);
        flash('Saved master');
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const handleExportChops = async () => {
    if (!state.hasBuffer) return;
    flash('Rendering chops…');
    try {
      const stems = await engine.exportChops(24);
      if (stems.length === 0) { setError('No assigned pads to export'); return; }
      if (mpcExportDir && ipc?.exportToMpc) {
        const r = await ipc.exportToMpc(stems);
        flash(r.error ? `ERR: ${r.error}` : `SAVED ${stems.length} chops → ${r.savedTo}`);
      } else if (ipc?.exportAllStems) {
        await ipc.exportAllStems(stems);
        flash(`Saved ${stems.length} chops`);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  return (
    <div className="chopper-view">
      <div className="chopper-toolbar">
        <div className="toolbar-group">
          <label className="toolbar-field">
            <span className="toolbar-label">PLAYLIST</span>
            <select className="ctrl-select" value={selectedPlaylist}
              onChange={e => setSelectedPlaylist(e.target.value)}
              disabled={state.isLoading}>
              {playlists.length === 0 && <option value="">(no playlists)</option>}
              {playlists.map(p => (
                <option key={p.name} value={p.name}>{p.name} ({p.entries.length})</option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-primary"
            onClick={loadRandomFromPlaylist}
            disabled={state.isLoading || !selectedPlaylist}
          >
            {state.isLoading ? 'PULLING…' : '⤓ GET SAMPLE'}
          </button>
        </div>

        <div className="toolbar-group">
          <UrlInput onLoad={loadCustomUrl} disabled={state.isLoading} />
        </div>

        <div className="toolbar-group toolbar-track-info">
          {state.trackTitle && (
            <>
              <span className="track-title" title={state.trackTitle}>{state.trackTitle}</span>
              {state.bpm > 0 && <span className="track-bpm">{state.bpm} BPM</span>}
            </>
          )}
        </div>
      </div>

      {error && <div className="chopper-error">⚠ {error}</div>}
      {statusMsg && <div className="chopper-status">{statusMsg}</div>}

      <div className="chopper-waveform-wrap">
        <WaveformView
          state={state}
          buffer={engine.buffer}
          onSeekChop={onSeekChop}
          onAdjustChop={(id, side, t) => engine.setChopBoundary(id, side, t)}
        />
        {state.selectedPad !== null && (
          <div className="chopper-assign-hint">
            ASSIGNING PAD {state.selectedPad + 1} — click a chop on the waveform (Esc to cancel)
          </div>
        )}
      </div>

      <div className="chopper-main">
        <PadGrid
          state={state}
          onTrigger={onPadTrigger}
          onRelease={onPadRelease}
          onSelect={onPadSelect}
          onToggleMode={onPadToggleMode}
          onClear={onPadClear}
        />

        <MasterFXPanel
          state={state}
          onMasterVolume={v => engine.setMasterVolume(v)}
          onFilterFreq={v => engine.setFilterFreq(v)}
          onFilterEnabled={b => engine.setFilterEnabled(b)}
          onEQ={(band, v) => engine.setEQ(band, v)}
          onCompStyle={(s: CompressorStyle) => engine.setCompStyle(s)}
          onCompMix={v => engine.setCompMix(v)}
          onDelayTime={v => engine.setDelayTime(v)}
          onDelayFeedback={v => engine.setDelayFeedback(v)}
          onDelayMix={v => engine.setDelayMix(v)}
          onReverbMix={v => engine.setReverbMix(v)}
          onReverbDecay={v => engine.setReverbDecay(v)}
        />
      </div>

      <Timeline
        state={state}
        onClear={() => engine.clearTimeline()}
        onStartRecord={() => engine.startRecordingTimeline()}
        onStopRecord={() => engine.stopRecordingTimeline()}
      />

      <div className="chopper-export-bar">
        <div className="mpc-line">
          {mpcExportDir
            ? <><span className="mpc-dot mpc-dot-on" /> MPC → {mpcExportDir}</>
            : <><span className="mpc-dot" /> MPC: not detected (will save to dialog)</>}
        </div>
        <div className="export-actions">
          <button className="btn" onClick={handleExportMaster} disabled={!state.hasBuffer}>
            ⬇ EXPORT MASTER
          </button>
          <button className="btn" onClick={handleExportChops} disabled={!state.hasBuffer}>
            ⬇ EXPORT CHOPS
          </button>
        </div>
      </div>
    </div>
  );
}

function UrlInput({ onLoad, disabled }: { onLoad: (url: string) => void; disabled: boolean }) {
  const [v, setV] = useState('');
  return (
    <label className="toolbar-field">
      <span className="toolbar-label">OR URL</span>
      <input
        className="ctrl-input url-input"
        type="text"
        placeholder="https://youtube.com/…"
        value={v}
        onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !disabled) onLoad(v); }}
        disabled={disabled}
      />
    </label>
  );
}
