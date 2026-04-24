import { useEffect, useRef, useState, useCallback } from 'react';
import { AudioEngine, EngineState } from './audio/AudioEngine';
import { EffectKey } from './audio/Track';
import type { TranceGateSyncDiv } from './audio/effects/TranceGate';
import type { FilterType } from './audio/effects/Filter';
import { WAVBitDepth, ExportFormat } from './audio/StemExporter';
import { Transport } from './components/Transport';
import { TrackStrip } from './components/TrackStrip';
import { WaveformDisplay } from './components/WaveformDisplay';
import { MasterSection } from './components/MasterSection';

const ipc = (window as any).terminator as {
  exportStem:     (p: { name: string; data: ArrayBuffer }) => Promise<any>;
  exportAllStems: (stems: Array<{ name: string; data: ArrayBuffer }>) => Promise<any>;
} | undefined;

const DEFAULT_STATE: EngineState = {
  isPlaying: false, isRecording: false, isCountingIn: false, recordingTrackId: null,
  bpm: 140, bars: 4, swing: 50, quantizeGrid: '1/16',
  loopProgress: 0, currentBeat: 0, masterVolume: 0.85,
  tracks: [], metronomeOn: false, limiterEnabled: true, canUndo: false, canRedo: false,
  midiConnected: false, midiInputCount: 0,
};

type SpectrumMode = 'waveform' | 'spectrum';

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  const [state, setState] = useState<EngineState>(DEFAULT_STATE);
  const [specMode, setSpecMode] = useState<SpectrumMode>('waveform');

  useEffect(() => {
    const engine = new AudioEngine();
    engineRef.current = engine;
    const unsub = engine.subscribe(setState);
    engine.addTrack();
    return () => { unsub(); engine.dispose(); };
  }, []);

  const engine = engineRef.current;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === 'Space')                        { e.preventDefault(); state.isPlaying ? engine?.stop() : engine?.play(); }
      if (e.code === 'KeyZ' && e.metaKey && !e.shiftKey) engine?.undo();
      if (e.code === 'KeyZ' && e.metaKey &&  e.shiftKey) engine?.redo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, state.isPlaying]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleRecord = useCallback(async () => {
    if (!engine) return;
    const armedTrack = state.tracks.find(t => t.armed);
    if (armedTrack) {
      await engine.startRecording(armedTrack.id);
    } else {
      await engine.startRecording();
    }
  }, [engine, state.tracks]);

  const handleExportStems = useCallback(async (format: ExportFormat, bitDepth: WAVBitDepth, dry: boolean) => {
    if (!engine) return;
    const stems = await engine.exportAllStems({ format, bitDepth, dry });
    if (ipc) {
      await ipc.exportAllStems(stems);
    } else {
      for (const s of stems) downloadBlob(s.data, `${s.name}.wav`);
    }
  }, [engine]);

  const handleExportMaster = useCallback(async (format: ExportFormat, bitDepth: WAVBitDepth, dry: boolean) => {
    if (!engine) return;
    const master = await engine.exportMaster({ format, bitDepth, dry });
    if (ipc) {
      await ipc.exportStem(master);
    } else {
      downloadBlob(master.data, `${master.name}.wav`);
    }
  }, [engine]);

  const trackHandlers = useCallback((id: string) => ({
    onVolume:    (v: number) => engine?.setTrackVolume(id, v),
    onPan:       (v: number) => engine?.setTrackPan(id, v),
    onMute:      ()          => engine?.setTrackMute(id, !state.tracks.find(t => t.id === id)?.muted),
    onSolo:      ()          => engine?.setTrackSolo(id, !state.tracks.find(t => t.id === id)?.soloed),
    onArm:       ()          => engine?.setTrackArmed(id, !state.tracks.find(t => t.id === id)?.armed),
    onRecord:    ()          => engine?.startRecording(id),
    onOverdub:   ()          => engine?.overdub(id),
    onDuplicate: ()          => engine?.duplicateTrack(id),
    onRemove:    ()          => engine?.removeTrack(id),
    onRename:    (n: string) => engine?.setTrackName(id, n),
    onStretch:   (v: number) => engine?.setTrackStretch(id, v),
    onPitch:     (v: number) => engine?.setTrackPitch(id, v),
    onLoopStart: (v: number) => engine?.setTrackLoopStart(id, v),

    onEQ: (key: 'lowGain' | 'midGain' | 'highGain', v: number) =>
      engine?.setTrackEffect(id, t => {
        if (key === 'lowGain')  t.eq.setLow(v);
        if (key === 'midGain')  t.eq.setMid(v);
        if (key === 'highGain') t.eq.setHigh(v);
      }),
    onClipper: (key: 'amount' | 'drive' | 'mix', v: number) =>
      engine?.setTrackEffect(id, t => {
        if (key === 'amount') t.clipper.setAmount(v);
        if (key === 'drive')  t.clipper.setDrive(v);
        if (key === 'mix')    t.clipper.setMix(v);
      }),
    onWaveshaper: (key: 'drive' | 'mix', v: number) =>
      engine?.setTrackEffect(id, t => key === 'drive' ? t.waveshaper.setDrive(v) : t.waveshaper.setMix(v)),
    onSaturator: (key: 'drive' | 'mix' | 'lowFreq' | 'highFreq', v: number) =>
      engine?.setTrackEffect(id, t => {
        if (key === 'drive')    t.saturator.setDrive(v);
        if (key === 'mix')      t.saturator.setMix(v);
        if (key === 'lowFreq')  t.saturator.setLowFreq(v);
        if (key === 'highFreq') t.saturator.setHighFreq(v);
      }),
    onOTT: (key: 'depth' | 'mix', v: number) =>
      engine?.setTrackEffect(id, t => key === 'depth' ? t.ott.setDepth(v) : t.ott.setMix(v)),
    onWidener: (key: 'width' | 'mix', v: number) =>
      engine?.setTrackEffect(id, t => key === 'width' ? t.widener.setWidth(v) : t.widener.setMix(v)),
    onFilter: (key: 'type' | 'freq' | 'q' | 'mix', v: FilterType | number) =>
      engine?.setTrackEffect(id, t => {
        if (key === 'type') t.filter.setType(v as FilterType);
        if (key === 'freq') t.filter.setFreq(v as number);
        if (key === 'q')    t.filter.setQ(v as number);
        if (key === 'mix')  t.filter.setMix(v as number);
      }),
    onReverse:      () => engine?.setTrackReversed(id),
    onMidiArm:      () => engine?.setTrackMidiArmed(id, !state.tracks.find(t => t.id === id)?.midiArmed),
    onRootNote:     (n: number) => engine?.setTrackRootNote(id, n),
    onMSEQ: (key: 'midFreq' | 'midGain' | 'sideFreq' | 'sideGain' | 'mix', v: number) =>
      engine?.setTrackEffect(id, t => {
        if (key === 'midFreq')  t.mseq.setMidFreq(v);
        if (key === 'midGain')  t.mseq.setMidGain(v);
        if (key === 'sideFreq') t.mseq.setSideFreq(v);
        if (key === 'sideGain') t.mseq.setSideGain(v);
        if (key === 'mix')      t.mseq.setMix(v);
      }),
    onBitCrusher: (key: 'bits' | 'rate' | 'mix', v: number) =>
      engine?.setTrackEffect(id, t => {
        if (key === 'bits') t.bitcrusher.setBits(v);
        if (key === 'rate') t.bitcrusher.setRate(v);
        if (key === 'mix')  t.bitcrusher.setMix(v);
      }),
    onAutoPan: (key: 'rate' | 'depth' | 'mix', v: number) =>
      engine?.setTrackEffect(id, t => {
        if (key === 'rate')  t.autopan.setRate(v);
        if (key === 'depth') t.autopan.setDepth(v);
        if (key === 'mix')   t.autopan.setMix(v);
      }),
    onTranceGate: (key: 'rate' | 'depth' | 'attack' | 'release' | 'mix' | 'synced' | 'syncDiv', v: number | boolean | string) =>
      engine?.setTrackEffect(id, t => {
        if (key === 'rate')    t.trancegate.setRate(v as number);
        if (key === 'depth')   t.trancegate.setDepth(v as number);
        if (key === 'attack')  t.trancegate.setAttack(v as number);
        if (key === 'release') t.trancegate.setRelease(v as number);
        if (key === 'mix')     t.trancegate.setMix(v as number);
        if (key === 'synced')  t.trancegate.setSynced(v as boolean);
        if (key === 'syncDiv') t.trancegate.setSyncDiv(v as TranceGateSyncDiv);
      }),
    onChorus: (key: 'rate' | 'depth' | 'mix', v: number) =>
      engine?.setTrackEffect(id, t => {
        if (key === 'rate')  t.chorus.setRate(v);
        if (key === 'depth') t.chorus.setDepth(v);
        if (key === 'mix')   t.chorus.setMix(v);
      }),
    onDelay: (key: 'timeL' | 'timeR' | 'feedback' | 'mix' | 'pingPong', v: number | boolean) =>
      engine?.setTrackEffect(id, t => {
        if (key === 'timeL')    t.delay.setTimeL(v as number);
        if (key === 'timeR')    t.delay.setTimeR(v as number);
        if (key === 'feedback') t.delay.setFeedback(v as number);
        if (key === 'mix')      t.delay.setMix(v as number);
        if (key === 'pingPong') t.delay.setPingPong(v as boolean);
      }),
    onReverb: (key: 'mix' | 'decay' | 'preHPF', v: number) =>
      engine?.setTrackEffect(id, t => {
        if (key === 'mix')    t.reverb.setMix(v);
        if (key === 'decay')  t.reverb.setDecay(v);
        if (key === 'preHPF') t.reverb.setPreHPF(v);
      }),
    onBypassFX: (fx: EffectKey) =>
      engine?.setTrackEffect(id, t => t.setEffectBypassed(fx, !t.getState().effects[fx].bypassed)),
    onMasterBypass: () =>
      engine?.setTrackEffect(id, t => t.setMasterBypass(!t.masterBypass)),
    onReorderFX: (order: EffectKey[]) =>
      engine?.reorderTrackEffects(id, order),
  }), [engine, state.tracks]);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <div className="scanlines" aria-hidden />

      <Transport
        isPlaying={state.isPlaying}
        isRecording={state.isRecording}
        isCountingIn={state.isCountingIn}
        bpm={state.bpm}
        bars={state.bars}
        swing={state.swing}
        quantizeGrid={state.quantizeGrid}
        loopProgress={state.loopProgress}
        currentBeat={state.currentBeat}
        metronomeOn={state.metronomeOn}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        onPlay={()    => engine?.play()}
        onStop={()    => engine?.stop()}
        onRecord={handleRecord}
        onMetronome={() => engine?.toggleMetronome()}
        onBPM={(v)    => engine?.setBPM(v)}
        onBars={(v)   => engine?.setBars(v)}
        onSwing={(v)  => engine?.setSwing(v)}
        onGrid={(v)   => engine?.setQuantizeGrid(v)}
        onUndo={()    => engine?.undo()}
        onRedo={()    => engine?.redo()}
      />

      <div className="main-display">
        <div className="display-toolbar">
          <button className={`btn-mode ${specMode==='waveform' ? 'active' : ''}`} onClick={() => setSpecMode('waveform')}>WAVE</button>
          <button className={`btn-mode ${specMode==='spectrum' ? 'active' : ''}`} onClick={() => setSpecMode('spectrum')}>SPEC</button>
        </div>
        {engine && (
          <WaveformDisplay engine={engine} loopProgress={state.loopProgress} isPlaying={state.isPlaying} mode={specMode} />
        )}
      </div>

      <div className="body">
        <div className="tracks-panel">
          <div className="tracks-list">
            {state.tracks.map(t => {
              const h = trackHandlers(t.id);
              return (
                <TrackStrip
                  key={t.id}
                  state={t}
                  isRecordingThis={state.recordingTrackId === t.id}
                  {...h}
                />
              );
            })}
          </div>
          <button className="btn-add-track" onClick={() => engine?.addTrack()}>+ ADD TRACK</button>
        </div>

        <MasterSection
          masterVolume={state.masterVolume}
          limiterEnabled={state.limiterEnabled}
          onMasterVolume={(v) => engine?.setMasterVolume(v)}
          onLimiter={(v) => engine?.setLimiterEnabled(v)}
          onExportStems={handleExportStems}
          onExportMaster={handleExportMaster}
        />
      </div>
    </div>
  );
}

function downloadBlob(data: ArrayBuffer, filename: string) {
  const blob = new Blob([data], { type: 'audio/wav' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
