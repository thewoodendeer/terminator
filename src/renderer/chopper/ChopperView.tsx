import { useEffect, useRef, useState } from 'react';
import { ChopperEngine, ChopperState, ChopPreset, CompressorStyle, MetronomeSound } from './ChopperEngine';
import { PadGrid } from './PadGrid';
import { WaveformView } from './WaveformView';
import { MasterFXPanel } from './MasterFXPanel';
import { Timeline } from './Timeline';
import { estimateBPM } from './bpmDetect';

const ipc = (window as any).terminator as {
  listPlaylists: () => Promise<Array<{ name: string; entries: Array<{ id: string; title: string; duration?: number }> }>>;
  downloadYouTube: (idOrUrl: string) => Promise<{ ok: boolean; audio?: ArrayBuffer; cacheUrl?: string; title?: string; durationSec?: number; videoId?: string; error?: string }>;
  exportStem: (p: { name: string; data: ArrayBuffer }) => Promise<any>;
  exportAllStems: (stems: Array<{ name: string; data: ArrayBuffer }>) => Promise<any>;
  exportToMpc: (stems: Array<{ name: string; data: ArrayBuffer }>) => Promise<{ savedTo?: string; saved?: string[]; error?: string }>;
  ejectMpc: () => Promise<{ ok?: true; error?: string }>;
  onMpcStatus: (handler: (mountpoint: string | null) => void) => () => void;
  getCacheStatus: (playlistName: string) => Promise<{ cached: number; total: number; sizeMB: number }>;
  downloadPlaylist: (playlistName: string) => Promise<{ ok: boolean; done: number; errors: number }>;
  deletePlaylistCache: (playlistName: string) => Promise<{ deleted: number }>;
  onCacheProgress: (handler: (p: { playlistName: string; done: number; total: number; currentTitle: string; active: string[] }) => void) => () => void;
  savePreset: (preset: ChopPreset) => Promise<{ ok: boolean }>;
  loadPreset: (videoId: string) => Promise<ChopPreset | null>;
} | undefined;

type Playlist = { name: string; entries: Array<{ id: string; title: string; duration?: number }> };

const METRO_SOUNDS: { value: MetronomeSound; label: string }[] = [
  { value: 'click',   label: 'CLICK' },
  { value: 'hihat',   label: 'HI-HAT' },
  { value: 'rimshot', label: 'RIM' },
  { value: 'kick',    label: 'KICK' },
  { value: 'clap',    label: 'CLAP' },
];

export function ChopperView() {
  const engineRef = useRef<ChopperEngine | null>(null);
  if (!engineRef.current) engineRef.current = new ChopperEngine();
  const engine = engineRef.current!;

  const [state, setState] = useState<ChopperState>(() => engine.getState());
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(1);
  const viewRef = useRef({ viewStart: 0, viewEnd: 1 });
  viewRef.current = { viewStart, viewEnd };
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [mpcExportDir, setMpcExportDir] = useState<string | null>(null);
  const [cacheStatus, setCacheStatus] = useState<{ cached: number; total: number; sizeMB: number } | null>(null);
  const [dlProgress, setDlProgress] = useState<{ done: number; total: number; currentTitle: string; active: string[] } | null>(null);
  const [midiInputs, setMidiInputs] = useState<string[]>([]);
  const [midiLearn, setMidiLearn] = useState(false);
  const [midiLearnIdx, setMidiLearnIdx] = useState(0); // next pad to learn
  const [midiMap, setMidiMap] = useState<Record<number, number>>(() => {
    // default: notes 36-51 → pads 0-15
    const m: Record<number, number> = {};
    for (let i = 0; i < 16; i++) m[36 + i] = i;
    return m;
  });
  const [currentVideoId, setCurrentVideoId] = useState<string | null>(null);
  const [midiKillNote, setMidiKillNote] = useState<number | null>(null);
  const [midiLearnKill, setMidiLearnKill] = useState(false);
  const midiMapRef = useRef<Record<number, number>>({});
  const midiLearnRef = useRef(false);
  const midiLearnIdxRef = useRef(0);
  const midiKillNoteRef = useRef<number | null>(null);
  const midiLearnKillRef = useRef(false);
  midiMapRef.current = midiMap;
  midiLearnRef.current = midiLearn;
  midiLearnIdxRef.current = midiLearnIdx;
  midiKillNoteRef.current = midiKillNote;
  midiLearnKillRef.current = midiLearnKill;

  useEffect(() => {
    const unsub = engine.subscribe(setState);
    return () => { unsub(); };
  }, [engine]);

  useEffect(() => {
    if (!ipc?.listPlaylists) return;
    ipc.listPlaylists().then(pls => {
      setPlaylists(pls);
      if (pls.length > 0) setSelectedPlaylist(pls[0].name);
    });
  }, []);

  useEffect(() => {
    if (!ipc?.onMpcStatus) return;
    return ipc.onMpcStatus(setMpcExportDir);
  }, []);

  // Refresh cache status whenever the selected playlist changes
  useEffect(() => {
    if (!ipc?.getCacheStatus || !selectedPlaylist) return;
    ipc.getCacheStatus(selectedPlaylist).then(setCacheStatus);
  }, [selectedPlaylist]);

  // Listen for batch-download progress events
  useEffect(() => {
    if (!ipc?.onCacheProgress) return;
    return ipc.onCacheProgress(p => {
      if (p.playlistName !== selectedPlaylist) return;
      setDlProgress({ done: p.done, total: p.total, currentTitle: p.currentTitle, active: p.active });
      if (p.done >= p.total) {
        setDlProgress(null);
        ipc.getCacheStatus!(p.playlistName).then(setCacheStatus);
      }
    });
  }, [selectedPlaylist]);

  const handleDownloadPlaylist = async () => {
    if (!ipc?.downloadPlaylist || !selectedPlaylist) return;
    const pl = playlists.find(p => p.name === selectedPlaylist);
    setDlProgress({ done: 0, total: pl?.entries.length ?? 0, currentTitle: '', active: [] });
    await ipc.downloadPlaylist(selectedPlaylist);
    setDlProgress(null);
    ipc.getCacheStatus!(selectedPlaylist).then(setCacheStatus);
  };

  const handleDeleteCache = async () => {
    if (!ipc?.deletePlaylistCache || !selectedPlaylist) return;
    await ipc.deletePlaylistCache(selectedPlaylist);
    ipc.getCacheStatus!(selectedPlaylist).then(setCacheStatus);
    flash('Cache deleted');
  };

  useEffect(() => {
    return () => { engine.dispose(); };
  }, [engine]);

  // MIDI input — map notes 36-51 (MPC bank A) to pads 1-16
  useEffect(() => {
    if (!navigator.requestMIDIAccess) {
      console.warn('[MIDI] navigator.requestMIDIAccess not available');
      return;
    }
    let access: MIDIAccess;

    const onMessage = (e: MIDIMessageEvent) => {
      const [status, note, velocity] = e.data as unknown as [number, number, number];
      const cmd = status & 0xf0;
      const isNoteOn  = cmd === 0x90 && velocity > 0;
      const isNoteOff = cmd === 0x80 || (cmd === 0x90 && velocity === 0);
      if (!isNoteOn && !isNoteOff) return;

      // Kill learn mode: assign incoming note as kill trigger
      if (isNoteOn && midiLearnKillRef.current) {
        setMidiKillNote(note);
        setMidiLearnKill(false);
        return;
      }

      // Kill trigger
      if (isNoteOn && note === midiKillNoteRef.current) {
        engine.stopAllPads();
        return;
      }

      // Pad learn mode: map incoming note → next pad in sequence
      if (isNoteOn && midiLearnRef.current) {
        const learnIdx = midiLearnIdxRef.current;
        if (learnIdx < 16) {
          setMidiMap(prev => ({ ...prev, [note]: learnIdx }));
          const next = learnIdx + 1;
          setMidiLearnIdx(next);
          if (next >= 16) setMidiLearn(false);
        }
        return;
      }

      const padIdx = midiMapRef.current[note];
      if (padIdx === undefined) return;
      if (isNoteOn)  engine.triggerPad(padIdx, velocity / 127);
      if (isNoteOff) engine.releasePad(padIdx);
    };

    const refreshInputs = (acc: MIDIAccess) => {
      const names: string[] = [];
      acc.inputs.forEach(input => {
        console.log('[MIDI] input:', input.name, input.state);
        input.onmidimessage = onMessage;
        names.push(input.name ?? 'Unknown');
      });
      console.log('[MIDI] total inputs:', names.length);
      setMidiInputs(names);
    };

    navigator.requestMIDIAccess({ sysex: false }).then(acc => {
      console.log('[MIDI] access granted, inputs:', acc.inputs.size);
      access = acc;
      refreshInputs(acc);
      acc.onstatechange = (e) => { console.log('[MIDI] state change:', (e as any).port?.name, (e as any).port?.state); refreshInputs(acc); };
    }).catch(err => { console.error('[MIDI] access denied:', err); });

    return () => {
      if (access) access.inputs.forEach(i => { i.onmidimessage = null; });
    };
  }, [engine]);

  const flash = (msg: string, ms = 4000) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(s => (s === msg ? null : s)), ms);
  };

  // Resolve audio bytes from an IPC response — cache hits come back as a URL
  // served by the terminator-cache:// protocol (no IPC byte transfer)
  const resolveAudio = async (res: { audio?: ArrayBuffer; cacheUrl?: string }): Promise<ArrayBuffer> => {
    if (res.cacheUrl) {
      const r = await fetch(res.cacheUrl);
      if (!r.ok) throw new Error(`Cache fetch failed: ${r.status}`);
      return r.arrayBuffer();
    }
    if (res.audio) return res.audio;
    throw new Error('No audio data in response');
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
      if (!res.ok) { setError(res.error ?? 'Download failed'); engine.setLoading(false); return; }
      const audio = await resolveAudio(res);
      await engine.loadFromArrayBuffer(audio, res.title ?? pick.title);
      if (engine.buffer) {
        const bpm = estimateBPM(engine.buffer);
        if (bpm > 0) engine.setBpm(bpm);
        engine.setMetronomeBpm(bpm > 0 ? bpm : 120);
      }
      const vid = res.videoId ?? pick.id;
      setCurrentVideoId(vid);
      if (ipc?.loadPreset) {
        const preset = await ipc.loadPreset(vid);
        if (preset) { engine.loadPreset(preset); flash(`Loaded: ${res.title ?? pick.title} — preset restored`); }
        else flash(`Loaded: ${res.title ?? pick.title}`);
      } else {
        flash(`Loaded: ${res.title ?? pick.title}`);
      }
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
      if (!res.ok) { setError(res.error ?? 'Download failed'); engine.setLoading(false); return; }
      const audio = await resolveAudio(res);
      await engine.loadFromArrayBuffer(audio, res.title ?? 'untitled');
      if (engine.buffer) {
        const bpm = estimateBPM(engine.buffer);
        if (bpm > 0) engine.setBpm(bpm);
        engine.setMetronomeBpm(bpm > 0 ? bpm : 120);
      }
      const vid = res.videoId ?? url.trim();
      setCurrentVideoId(vid);
      if (ipc?.loadPreset) {
        const preset = await ipc.loadPreset(vid);
        if (preset) { engine.loadPreset(preset); flash(`Loaded: ${res.title ?? 'untitled'} — preset restored`); }
        else flash(`Loaded: ${res.title ?? 'untitled'}`);
      } else {
        flash(`Loaded: ${res.title ?? 'untitled'}`);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      engine.setLoading(false);
    }
  };

  const onPadTrigger = (idx: number, vel = 1) => engine.triggerPad(idx, vel);
  const onPadRelease = (idx: number) => engine.releasePad(idx);
  const onPadSelect = (idx: number) => engine.selectPad(state.selectedPad === idx ? null : idx);
  const onPadToggleMode = (idx: number) => engine.togglePadMode(idx);
  const onPadClear = (idx: number) => engine.clearPad(idx);
  const onPadPitch = (idx: number, s: number) => engine.setPadPitch(idx, s);

  const onSeekChop = (chopId: number) => {
    if (state.selectedPad !== null) {
      engine.assignChopToPad(state.selectedPad, chopId);
      engine.selectPad(null);
    } else {
      const pad = state.pads.find(p => p.chopId === chopId);
      if (pad) engine.triggerPad(pad.index);
    }
  };

  // Focused pad: last active or selected
  const focusedPadIdx = state.activePads.length > 0 ? state.activePads[0]
    : state.selectedPad !== null ? state.selectedPad : null;

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (typing) return;

      if (e.key === 'Escape') { engine.stopAllPads(); engine.selectPad(null); return; }

      if (e.key === ' ') {
        e.preventDefault();
        if (state.activePads.length > 0) engine.stopAllPads();
        else engine.triggerPad(0, 1);
        return;
      }

      // , / . → zoom out / in (centered on current view midpoint)
      if (e.key === ',' || e.key === '.') {
        e.preventDefault();
        const { viewStart: vs, viewEnd: ve } = viewRef.current;
        const mid = (vs + ve) / 2;
        const span = e.key === '.'
          ? Math.max(0.005, (ve - vs) * 0.6)
          : Math.min(1, (ve - vs) * 1.5);
        const ns = Math.max(0, mid - span / 2);
        const ne = Math.min(1, ns + span);
        setViewStart(ns); setViewEnd(ne);
        return;
      }

      // Arrow left/right → nudge focused chop start (zoom-aware)
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && focusedPadIdx !== null) {
        e.preventDefault();
        const pad = state.pads[focusedPadIdx];
        if (!pad || pad.chopId === null || !engine.buffer) return;
        const chop = state.chops.find(c => c.id === pad.chopId);
        if (!chop) return;
        const { viewStart: vs, viewEnd: ve } = viewRef.current;
        const nudge = (ve - vs) * engine.buffer.duration * 0.005;
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        engine.setChopBoundary(pad.chopId, 'start', chop.start + dir * nudge);
        return;
      }

      // Arrow up/down → pitch focused pad up/down
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && focusedPadIdx !== null) {
        e.preventDefault();
        const pad = state.pads[focusedPadIdx];
        if (!pad) return;
        const step = e.shiftKey ? 0.1 : 0.5;
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        engine.setPadPitch(focusedPadIdx, pad.pitch + dir * step);
        return;
      }

      // / → delete focused pad's chop
      if (e.key === '/' && focusedPadIdx !== null) {
        e.preventDefault();
        engine.clearPad(focusedPadIdx);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, state.activePads, state.selectedPad, state.pads, state.chops, focusedPadIdx]);

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
    } catch (e: any) { setError(e?.message ?? String(e)); }
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
    } catch (e: any) { setError(e?.message ?? String(e)); }
  };

  return (
    <div className="chopper-view">
      {/* ── Toolbar ── */}
      <div className="chopper-toolbar">
        <div className="toolbar-group">
          <label className="toolbar-field">
            <span className="toolbar-label">PLAYLIST</span>
            <select className="ctrl-select" value={selectedPlaylist}
              onChange={e => setSelectedPlaylist(e.target.value)}
              disabled={state.isLoading}>
              {playlists.length === 0 && <option value="">(no playlists)</option>}
              {playlists.map((p, i) => (
                <option key={i} value={p.name}>{p.name} ({p.entries.length})</option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary" onClick={loadRandomFromPlaylist}
            disabled={state.isLoading || !selectedPlaylist}>
            {state.isLoading ? 'PULLING…' : '⤓ GET SAMPLE'}
          </button>
          <button
            className={`btn btn-cache-dl ${dlProgress ? 'cache-dl-active' : ''}`}
            onClick={handleDownloadPlaylist}
            disabled={!!dlProgress || !selectedPlaylist}
            title="Download entire playlist to disk for instant loading"
          >
            {dlProgress
              ? `${dlProgress.done}/${dlProgress.total}`
              : cacheStatus && cacheStatus.cached > 0
                ? `CACHED ${cacheStatus.cached}/${cacheStatus.total}`
                : '⬇ DL PLAYLIST'}
          </button>
          {cacheStatus && cacheStatus.cached > 0 && !dlProgress && (
            <button
              className="btn btn-cache-del"
              onClick={handleDeleteCache}
              title="Delete cached audio files for this playlist"
            >
              DEL {cacheStatus.sizeMB >= 1000
                ? `${(cacheStatus.sizeMB / 1024).toFixed(1)}GB`
                : `${Math.round(cacheStatus.sizeMB)}MB`}
            </button>
          )}
        </div>

        <div className="toolbar-group">
          <UrlInput onLoad={loadCustomUrl} disabled={state.isLoading} />
        </div>

        {/* Metronome */}
        <div className="toolbar-group metro-group">
          <button
            className={`btn-metro ${state.metronome.enabled ? 'metro-on' : ''}`}
            onClick={() => engine.toggleMetronome()}
            title="Toggle metronome"
          >
            {state.metronome.enabled ? '♩ ON' : '♩ OFF'}
          </button>
          <BpmInput
            bpm={state.metronome.bpm}
            onChange={bpm => engine.setMetronomeBpm(bpm)}
          />
          <select
            className="ctrl-select metro-sound-select"
            value={state.metronome.sound}
            onChange={e => engine.setMetronomeSound(e.target.value as MetronomeSound)}
            title="Metronome sound"
          >
            {METRO_SOUNDS.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        {/* Chop mode toggle + reset */}
        <div className="toolbar-group">
          <button
            className={`btn-chop-mode ${state.chopMode ? 'chop-mode-on' : ''}`}
            onClick={() => engine.toggleChopMode()}
            title="Chop mode: hit empty pads while playing to drop chop points. Filled pads still play normally."
          >
            {state.chopMode ? '✂ CHOP ON' : '✂ CHOP OFF'}
          </button>
          <button
            className="btn-reset-chops"
            onClick={() => engine.autoChop(1)}
            disabled={!state.hasBuffer}
            title="Reset — full sample back on pad 1, clear all chop points"
          >
            RESET
          </button>
          <button
            className="btn-preset-save"
            disabled={!state.hasBuffer || !currentVideoId}
            title="Save chop preset for this track"
            onClick={async () => {
              if (!ipc?.savePreset || !currentVideoId) return;
              await ipc.savePreset(engine.getPresetData(currentVideoId));
              flash('Preset saved');
            }}
          >
            SAVE
          </button>
        </div>

        <div className="toolbar-group">
          <div className="midi-status" title={midiInputs.length ? midiInputs.join(', ') : 'No MIDI devices'}>
            <span className={`midi-dot ${midiInputs.length ? 'midi-dot-on' : ''}`} />
            {midiInputs.length ? midiInputs[0] : 'NO MIDI'}
          </div>
          {midiInputs.length > 0 && (
            <>
              <button
                className={`btn-midi-learn ${midiLearn ? 'midi-learn-on' : ''}`}
                onClick={() => { setMidiLearn(v => !v); setMidiLearnIdx(0); setMidiLearnKill(false); }}
                title="MIDI Learn: press to start, then hit each MPC pad in order (1–16)"
              >
                {midiLearn ? `LEARN ${midiLearnIdx + 1}/16` : 'LEARN'}
              </button>
              <button
                className={`btn-midi-learn ${midiLearnKill ? 'midi-learn-on' : ''}`}
                onClick={() => { setMidiLearnKill(v => !v); setMidiLearn(false); }}
                title={midiKillNote !== null ? `Kill mapped to note ${midiKillNote} — click to remap` : 'Learn a MIDI button to kill all audio'}
              >
                {midiLearnKill ? 'HIT KILL BTN' : midiKillNote !== null ? 'KILL ✓' : 'KILL'}
              </button>
            </>
          )}
        </div>

        <div className="toolbar-group toolbar-track-info">
          {state.trackTitle && (
            <>
              <span className="track-title" title={state.trackTitle}>{state.trackTitle}</span>
              {state.bpm > 0 && <span className="track-bpm">{Math.round(state.bpm)} BPM</span>}
            </>
          )}
        </div>
      </div>

      {dlProgress && (
        <div className="cache-dl-panel">
          <div className="cache-dl-header">
            <span className="cache-dl-label">DOWNLOADING — {selectedPlaylist}</span>
            <span className="cache-dl-count">{dlProgress.done} / {dlProgress.total} &nbsp; {Math.round((dlProgress.done / dlProgress.total) * 100)}%</span>
          </div>
          <div className="cache-dl-bar-track">
            <div className="cache-dl-bar-fill" style={{ width: `${(dlProgress.done / dlProgress.total) * 100}%` }} />
          </div>
          {dlProgress.active.length > 0 && (
            <div className="cache-dl-active-list">
              {dlProgress.active.map((t, i) => (
                <span key={i} className="cache-dl-active-item">⬇ {t}</span>
              ))}
            </div>
          )}
          {dlProgress.active.length === 0 && dlProgress.currentTitle && (
            <div className="cache-dl-active-list">
              <span className="cache-dl-active-item cache-dl-done-item">✓ {dlProgress.currentTitle}</span>
            </div>
          )}
        </div>
      )}

      {error && <div className="chopper-error">⚠ {error}</div>}
      {statusMsg && <div className="chopper-status">{statusMsg}</div>}

      {/* ── Waveform ── */}
      <div className="chopper-waveform-wrap">
        <WaveformView
          state={state}
          buffer={engine.buffer}
          onSeekChop={onSeekChop}
          onAdjustChop={(id, side, t) => engine.setChopBoundary(id, side, t)}
          viewStart={viewStart}
          viewEnd={viewEnd}
          onViewChange={(vs, ve) => { setViewStart(vs); setViewEnd(ve); }}
        />
        {state.selectedPad !== null && (
          <div className="chopper-assign-hint">
            ASSIGNING PAD {state.selectedPad + 1} — click a chop on the waveform (Esc to cancel)
          </div>
        )}
        {state.chopMode && state.activePads.length > 0 && (
          <div className="chopper-chop-hint">
            ✂ CHOP MODE — hit any other pad to slice here
          </div>
        )}
      </div>

      {/* ── Pads + FX ── */}
      <div className="chopper-main">
        <PadGrid
          state={state}
          onTrigger={onPadTrigger}
          onRelease={onPadRelease}
          onSelect={onPadSelect}
          onToggleMode={onPadToggleMode}
          onClear={onPadClear}
          onPitch={onPadPitch}
        />
        <MasterFXPanel
          state={state}
          onMasterVolume={v => engine.setMasterVolume(v)}
          onMasterPitch={v => engine.setMasterPitch(v)}
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

      {/* ── Timeline ── */}
      <Timeline
        state={state}
        onClear={() => engine.clearTimeline()}
        onStartRecord={() => engine.startRecordingTimeline()}
        onStopRecord={() => engine.stopRecordingTimeline()}
      />

      {/* ── Export bar ── */}
      <div className="chopper-export-bar">
        <div className="mpc-line">
          {mpcExportDir
            ? <><span className="mpc-dot mpc-dot-on" /> MPC → {mpcExportDir}</>
            : <><span className="mpc-dot" /> MPC: not detected (will save to dialog)</>}
        </div>
        <div className="export-actions">
          <button className="btn btn-stop" onClick={() => engine.stopAllPads()} disabled={!state.hasBuffer}>
            ■ STOP
          </button>
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
      <input className="ctrl-input url-input" type="text" placeholder="https://youtube.com/…"
        value={v} onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !disabled) onLoad(v); }}
        disabled={disabled} />
    </label>
  );
}

function BpmInput({ bpm, onChange }: { bpm: number; onChange: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    onChange(Math.max(20, Math.min(300, bpm + (e.deltaY < 0 ? 1 : -1))));
  };

  if (editing) {
    return (
      <input
        className="ctrl-input bpm-input"
        type="number"
        value={raw}
        autoFocus
        onChange={e => setRaw(e.target.value)}
        onBlur={() => {
          const n = parseInt(raw, 10);
          if (!isNaN(n)) onChange(Math.max(20, Math.min(300, n)));
          setEditing(false);
        }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    );
  }
  return (
    <div className="bpm-display" onDoubleClick={() => { setRaw(String(bpm)); setEditing(true); }} onWheel={handleWheel}>
      <span className="bpm-label">BPM</span>
      <span className="bpm-value">{bpm}</span>
    </div>
  );
}
