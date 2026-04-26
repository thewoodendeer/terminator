import { Filter } from '../audio/effects/Filter';
import { EQ3 } from '../audio/effects/EQ3';
import { Compressor } from '../audio/effects/Compressor';
import { Delay } from '../audio/effects/Delay';
import { Reverb } from '../audio/effects/Reverb';
import { encodeWAV, WAVBitDepth } from '../audio/StemExporter';

export type PadMode = 'oneshot' | 'loop';
export type CompressorStyle = 'off' | 'light' | 'punchy' | 'ny' | 'aggressive';
export type MetronomeSound = 'click' | 'hihat' | 'rimshot' | 'kick' | 'clap';

export interface Chop {
  id: number;
  start: number;
  end: number;
}

export interface Pad {
  index: number;
  chopId: number | null;
  mode: PadMode;
  color: string;
  pitch: number; // semitones -24..+24
}

export interface TimelineEvent {
  padIdx: number;
  time: number;
  duration: number;
}

const PAD_COLORS = [
  '#00ff88', '#00ccff', '#cc00ff', '#ff6600',
  '#ffcc00', '#ff0066', '#00ff00', '#ff00cc',
  '#33aaff', '#ff3333', '#88ff33', '#ff99cc',
  '#33ffcc', '#cc33ff', '#ffaa00', '#aa00ff',
];

const COMP_PRESETS: Record<CompressorStyle, { drive: number; ratio: number; attack: number; release: number; makeup: number; mix: number }> = {
  off:        { drive: 0,  ratio: 1,  attack: 0.01,  release: 0.15, makeup: 0, mix: 0 },
  light:      { drive: 3,  ratio: 2,  attack: 0.030, release: 0.20, makeup: 2, mix: 1.0 },
  punchy:     { drive: 6,  ratio: 4,  attack: 0.010, release: 0.08, makeup: 4, mix: 1.0 },
  ny:         { drive: 12, ratio: 8,  attack: 0.001, release: 0.05, makeup: 6, mix: 0.5 },
  aggressive: { drive: 18, ratio: 12, attack: 0.001, release: 0.03, makeup: 8, mix: 1.0 },
};

interface PadVoice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  startCtxTime: number;
  chopStart: number;
}

export interface ChopperState {
  hasBuffer: boolean;
  bufferDuration: number;
  trackTitle: string;
  bpm: number;
  chops: Chop[];
  pads: Pad[];
  selectedPad: number | null;
  activePads: number[];
  chopMode: boolean;
  playbackPos: number; // current playback position in buffer seconds (-1 = nothing playing)
  master: {
    volume: number;
    filterFreq: number;
    filterEnabled: boolean;
    eqLow: number;
    eqMid: number;
    eqHigh: number;
    compStyle: CompressorStyle;
    compMix: number;
    delayTime: number;
    delayFeedback: number;
    delayMix: number;
    reverbMix: number;
    reverbDecay: number;
  };
  metronome: {
    enabled: boolean;
    bpm: number;
    sound: MetronomeSound;
    beat: number; // current beat count (for accent on beat 1)
  };
  isLoaded: boolean;
  isLoading: boolean;
  recording: boolean;
  timeline: TimelineEvent[];
}

export class ChopperEngine {
  readonly ctx: AudioContext;
  private masterGain: GainNode;
  private masterLimiter: DynamicsCompressorNode;
  private filter: Filter;
  private eq: EQ3;
  private compressor: Compressor;
  private compDryGain: GainNode;
  private compWetGain: GainNode;
  private compMixIn: GainNode;
  private compMixOut: GainNode;
  private delay: Delay;
  private reverb: Reverb;
  private padBus: GainNode;

  buffer: AudioBuffer | null = null;
  trackTitle = '';
  bpm = 0;
  private chops: Chop[] = [];
  private pads: Pad[] = [];
  private nextChopId = 1;
  private voices: Map<number, PadVoice> = new Map();
  private activePadSet = new Set<number>();
  private selectedPad: number | null = null;
  private chopMode = true;

  private recording = false;
  private recordStart = 0;
  private timeline: TimelineEvent[] = [];
  private masterState: ChopperState['master'];
  private isLoading = false;
  private listeners = new Set<(s: ChopperState) => void>();

  // Metronome
  private metronomeEnabled = false;
  private metronomeBpm = 120;
  private metronomeSound: MetronomeSound = 'click';
  private metronomeBeat = 0;
  private metronomeTimer: ReturnType<typeof setInterval> | null = null;
  private nextBeatTime = 0;
  // Noise buffer shared for all noise-based sounds
  private noiseBuffer: AudioBuffer | null = null;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.85;

    this.masterLimiter = this.ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -1;
    this.masterLimiter.knee.value = 0;
    this.masterLimiter.ratio.value = 20;
    this.masterLimiter.attack.value = 0.001;
    this.masterLimiter.release.value = 0.05;

    this.filter = new Filter(this.ctx);
    this.eq = new EQ3(this.ctx);
    this.compressor = new Compressor(this.ctx);
    this.delay = new Delay(this.ctx);
    this.reverb = new Reverb(this.ctx);

    this.compMixIn  = this.ctx.createGain();
    this.compMixOut = this.ctx.createGain();
    this.compDryGain = this.ctx.createGain();
    this.compWetGain = this.ctx.createGain();
    this.compMixIn.connect(this.compDryGain);
    this.compMixIn.connect(this.compressor.input);
    this.compDryGain.connect(this.compMixOut);
    this.compressor.output.connect(this.compWetGain);
    this.compWetGain.connect(this.compMixOut);

    this.filter.setBypassed(false);
    this.filter.setType('lowpass');
    this.filter.setFreq(20000);
    this.filter.setQ(6);
    this.filter.setMix(1);
    this.eq.setBypassed(false);
    this.eq.setLow(0); this.eq.setMid(0); this.eq.setHigh(0);
    this.delay.setBypassed(true);
    this.reverb.setBypassed(true);

    this.padBus = this.ctx.createGain();
    this.padBus.connect(this.filter.input);
    this.filter.output.connect(this.eq.input);
    this.eq.output.connect(this.compMixIn);
    this.compMixOut.connect(this.delay.input);
    this.delay.output.connect(this.reverb.input);
    this.reverb.output.connect(this.masterGain);
    this.masterGain.connect(this.masterLimiter);
    this.masterLimiter.connect(this.ctx.destination);

    this.pads = Array.from({ length: 16 }, (_, i) => ({
      index: i,
      chopId: null,
      mode: 'oneshot' as PadMode,
      color: PAD_COLORS[i],
      pitch: 0,
    }));

    this.masterState = {
      volume: 0.85, filterFreq: 20000, filterEnabled: false,
      eqLow: 0, eqMid: 0, eqHigh: 0,
      compStyle: 'off', compMix: 0,
      delayTime: 0.25, delayFeedback: 0.3, delayMix: 0,
      reverbMix: 0, reverbDecay: 2,
    };
    this.applyCompPreset('off');
    this.buildNoiseBuffer();
  }

  private buildNoiseBuffer() {
    const len = this.ctx.sampleRate * 0.2;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  subscribe(handler: (s: ChopperState) => void): () => void {
    this.listeners.add(handler);
    handler(this.getState());
    return () => { this.listeners.delete(handler); };
  }

  private emit(): void {
    const s = this.getState();
    for (const h of this.listeners) h(s);
  }

  getState(): ChopperState {
    // Compute current playback position from any active voice
    let playbackPos = -1;
    for (const [, v] of this.voices) {
      playbackPos = v.chopStart + (this.ctx.currentTime - v.startCtxTime);
      break;
    }

    return {
      hasBuffer: this.buffer !== null,
      bufferDuration: this.buffer?.duration ?? 0,
      trackTitle: this.trackTitle,
      bpm: this.bpm,
      chops: [...this.chops],
      pads: this.pads.map(p => ({ ...p })),
      selectedPad: this.selectedPad,
      activePads: [...this.activePadSet],
      chopMode: this.chopMode,
      playbackPos,
      master: { ...this.masterState },
      metronome: {
        enabled: this.metronomeEnabled,
        bpm: this.metronomeBpm,
        sound: this.metronomeSound,
        beat: this.metronomeBeat,
      },
      isLoaded: this.buffer !== null,
      isLoading: this.isLoading,
      recording: this.recording,
      timeline: [...this.timeline],
    };
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  setLoading(b: boolean): void { this.isLoading = b; this.emit(); }

  async loadFromArrayBuffer(ab: ArrayBuffer, title: string): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const decoded = await this.ctx.decodeAudioData(ab.slice(0));
    this.buffer = decoded;
    this.trackTitle = title;
    this.stopAllPads();
    // Default: 1 chop covering the full sample on pad 1
    this.autoChop(1);
    this.emit();
  }

  // ── Chops ──────────────────────────────────────────────────────────────────

  autoChop(n: number): void {
    if (!this.buffer) return;
    const dur = this.buffer.duration;
    const step = dur / n;
    this.chops = Array.from({ length: n }, (_, i) => ({
      id: this.nextChopId++,
      start: i * step,
      end: (i + 1) * step,
    }));
    this.pads.forEach((p, i) => { p.chopId = i < this.chops.length ? this.chops[i].id : null; });
    this.emit();
  }

  setChopBoundary(chopId: number, side: 'start' | 'end', value: number): void {
    const idx = this.chops.findIndex(x => x.id === chopId);
    if (idx < 0 || !this.buffer) return;
    const c = this.chops[idx];
    const v = Math.max(0, Math.min(this.buffer.duration, value));
    if (side === 'start') {
      const prevEnd = idx > 0 ? this.chops[idx - 1].end : 0;
      c.start = Math.max(prevEnd, Math.min(v, c.end - 0.01));
    } else {
      const nextStart = idx < this.chops.length - 1 ? this.chops[idx + 1].start : this.buffer.duration;
      c.end = Math.min(nextStart, Math.max(v, c.start + 0.01));
    }
    this.emit();
  }

  // ── Chop-while-playing ────────────────────────────────────────────────────

  toggleChopMode(): void {
    this.chopMode = !this.chopMode;
    this.emit();
  }

  /** Slice at current playback position and assign new chop to targetPadIdx. */
  private sliceAtCurrentPosition(targetPadIdx: number): void {
    if (!this.buffer || this.voices.size === 0) return;

    // Get playback position from the first active voice
    let pos = -1;
    for (const [, voice] of this.voices) {
      pos = voice.chopStart + (this.ctx.currentTime - voice.startCtxTime);
      break;
    }
    if (pos < 0) return;

    // Find which chop contains this position
    const srcIdx = this.chops.findIndex(c => pos >= c.start && pos < c.end);
    if (srcIdx < 0) return;
    const src = this.chops[srcIdx];

    // Minimum slice size: 10ms on each side
    if (pos - src.start < 0.01 || src.end - pos < 0.01) return;

    const newChop: Chop = { id: this.nextChopId++, start: pos, end: src.end };
    src.end = pos;
    this.chops.splice(srcIdx + 1, 0, newChop);

    // Assign new chop to target pad
    const pad = this.pads[targetPadIdx];
    if (pad) pad.chopId = newChop.id;

    // Stop all, start target pad from new chop start
    this.stopAllPads();
    this.startVoice(targetPadIdx, 1);
    this.emit();
  }

  // ── Pads ───────────────────────────────────────────────────────────────────

  selectPad(idx: number | null): void {
    this.selectedPad = idx;
    this.emit();
  }

  assignChopToPad(padIdx: number, chopId: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    pad.chopId = chopId;
    this.emit();
  }

  clearPad(padIdx: number): void {
    const pad = this.pads[padIdx];
    if (!pad || pad.chopId === null) return;
    this.stopVoice(padIdx);

    // Merge chop into neighbor before removing it
    const chopId = pad.chopId;
    const idx = this.chops.findIndex(c => c.id === chopId);
    if (idx >= 0) {
      const removed = this.chops[idx];
      if (idx > 0) {
        // Extend previous chop to absorb this region
        this.chops[idx - 1].end = removed.end;
      } else if (idx < this.chops.length - 1) {
        // First chop — extend next chop backwards
        this.chops[idx + 1].start = removed.start;
      }
      this.chops.splice(idx, 1);
      // Clear any pad that was pointing at this chop
      for (const p of this.pads) {
        if (p.chopId === chopId) p.chopId = null;
      }
    }

    this.emit();
  }

  setPadMode(padIdx: number, mode: PadMode): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    pad.mode = mode;
    this.emit();
  }

  togglePadMode(padIdx: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    pad.mode = pad.mode === 'oneshot' ? 'loop' : 'oneshot';
    this.emit();
  }

  setPadPitch(padIdx: number, semitones: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    pad.pitch = Math.max(-24, Math.min(24, semitones));
    this.emit();
  }

  triggerPad(padIdx: number, velocity = 1): void {
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});

    // Chop-while-playing: if voices are playing and this pad doesn't already have a chop,
    // or we're in chop mode — slice at current position and assign to this pad.
    if (this.chopMode && this.voices.size > 0 && padIdx !== [...this.voices.keys()][0]) {
      this.sliceAtCurrentPosition(padIdx);
      return;
    }

    // Stop all (mono choke)
    this.stopAllPads();

    const pad = this.pads[padIdx];
    if (!pad || pad.chopId === null || !this.buffer) return;

    this.startVoice(padIdx, velocity);

    if (this.recording) {
      const chop = this.chops.find(c => c.id === pad.chopId);
      if (chop) {
        this.timeline.push({
          padIdx,
          time: this.ctx.currentTime - this.recordStart,
          duration: chop.end - chop.start,
        });
      }
      this.emit();
    }
  }

  private startVoice(padIdx: number, velocity: number): void {
    const pad = this.pads[padIdx];
    if (!pad || pad.chopId === null || !this.buffer) return;
    const chop = this.chops.find(c => c.id === pad.chopId);
    if (!chop) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.detune.value = pad.pitch * 100;

    const gain = this.ctx.createGain();
    gain.gain.value = velocity;
    const t = this.ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(velocity, t + 0.005);
    src.connect(gain);
    gain.connect(this.padBus);

    const startCtxTime = this.ctx.currentTime;

    if (pad.mode === 'loop') {
      src.loop = true;
      src.loopStart = chop.start;
      src.loopEnd = chop.end;
      src.start(0, chop.start);
    } else {
      src.loop = false;
      src.start(0, chop.start, chop.end - chop.start);
      src.onended = () => {
        try { gain.disconnect(); } catch { /* */ }
        if (this.voices.get(padIdx)?.src === src) {
          this.voices.delete(padIdx);
          this.activePadSet.delete(padIdx);
          this.emit();
        }
      };
    }

    this.voices.set(padIdx, { src, gain, startCtxTime, chopStart: chop.start });
    this.activePadSet.add(padIdx);
    this.emit();
  }

  releasePad(padIdx: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    if (pad.mode === 'loop') this.stopVoice(padIdx);
  }

  private stopVoice(padIdx: number): void {
    const v = this.voices.get(padIdx);
    if (!v) return;
    const t = this.ctx.currentTime;
    try {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.linearRampToValueAtTime(0, t + 0.01);
      v.src.stop(t + 0.012);
    } catch { /* already stopped */ }
    this.voices.delete(padIdx);
    this.activePadSet.delete(padIdx);
  }

  stopAllPads(): void {
    for (const idx of [...this.voices.keys()]) this.stopVoice(idx);
    this.emit();
  }

  // ── Metronome ──────────────────────────────────────────────────────────────

  toggleMetronome(): void {
    this.metronomeEnabled = !this.metronomeEnabled;
    if (this.metronomeEnabled) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      this.metronomeBeat = 0;
      this.nextBeatTime = this.ctx.currentTime + 0.05;
      this.metronomeTimer = setInterval(() => this.metronomeSchedulerTick(), 25);
    } else {
      if (this.metronomeTimer) clearInterval(this.metronomeTimer);
      this.metronomeTimer = null;
    }
    this.emit();
  }

  setMetronomeBpm(bpm: number): void {
    this.metronomeBpm = Math.max(20, Math.min(300, bpm));
    this.emit();
  }

  setMetronomeSound(sound: MetronomeSound): void {
    this.metronomeSound = sound;
    this.emit();
  }

  private metronomeSchedulerTick(): void {
    const lookahead = 0.1;
    const beatDur = 60 / this.metronomeBpm;
    while (this.nextBeatTime < this.ctx.currentTime + lookahead) {
      this.scheduleMetronomeClick(this.nextBeatTime, this.metronomeBeat);
      this.metronomeBeat = (this.metronomeBeat + 1) % 4;
      this.nextBeatTime += beatDur;
    }
  }

  private scheduleMetronomeClick(time: number, beat: number): void {
    const ctx = this.ctx;
    const accent = beat === 0; // downbeat accent

    switch (this.metronomeSound) {
      case 'click': {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.frequency.value = accent ? 1400 : 900;
        osc.connect(env); env.connect(ctx.destination);
        env.gain.setValueAtTime(0, time);
        env.gain.linearRampToValueAtTime(accent ? 0.6 : 0.4, time + 0.001);
        env.gain.exponentialRampToValueAtTime(0.001, time + 0.06);
        osc.start(time); osc.stop(time + 0.07);
        break;
      }
      case 'hihat': {
        if (!this.noiseBuffer) break;
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        const hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass'; hpf.frequency.value = accent ? 9000 : 7000;
        const env = ctx.createGain();
        env.gain.setValueAtTime(accent ? 0.4 : 0.25, time);
        env.gain.exponentialRampToValueAtTime(0.001, time + (accent ? 0.08 : 0.05));
        src.connect(hpf); hpf.connect(env); env.connect(ctx.destination);
        src.start(time); src.stop(time + 0.1);
        break;
      }
      case 'rimshot': {
        if (!this.noiseBuffer) break;
        // Noise burst + short sine
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuffer;
        const bpf = ctx.createBiquadFilter();
        bpf.type = 'bandpass'; bpf.frequency.value = 1200; bpf.Q.value = 0.5;
        const nEnv = ctx.createGain();
        nEnv.gain.setValueAtTime(accent ? 0.5 : 0.35, time);
        nEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
        noise.connect(bpf); bpf.connect(nEnv); nEnv.connect(ctx.destination);
        noise.start(time); noise.stop(time + 0.06);

        const osc = ctx.createOscillator();
        const oEnv = ctx.createGain();
        osc.frequency.value = 200;
        oEnv.gain.setValueAtTime(accent ? 0.3 : 0.2, time);
        oEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
        osc.connect(oEnv); oEnv.connect(ctx.destination);
        osc.start(time); osc.stop(time + 0.05);
        break;
      }
      case 'kick': {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.frequency.setValueAtTime(accent ? 180 : 140, time);
        osc.frequency.exponentialRampToValueAtTime(40, time + 0.25);
        env.gain.setValueAtTime(accent ? 0.8 : 0.6, time);
        env.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
        osc.connect(env); env.connect(ctx.destination);
        osc.start(time); osc.stop(time + 0.35);
        break;
      }
      case 'clap': {
        if (!this.noiseBuffer) break;
        // 3 staggered noise bursts
        const delays = [0, 0.008, 0.016];
        for (const d of delays) {
          const src = ctx.createBufferSource();
          src.buffer = this.noiseBuffer;
          const hpf = ctx.createBiquadFilter();
          hpf.type = 'bandpass'; hpf.frequency.value = 1800; hpf.Q.value = 0.8;
          const env = ctx.createGain();
          const t = time + d;
          env.gain.setValueAtTime(accent ? 0.45 : 0.3, t);
          env.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
          src.connect(hpf); hpf.connect(env); env.connect(ctx.destination);
          src.start(t); src.stop(t + 0.07);
        }
        break;
      }
    }
  }

  // ── Timeline ───────────────────────────────────────────────────────────────

  startRecordingTimeline(): void {
    this.timeline = [];
    this.recording = true;
    this.recordStart = this.ctx.currentTime;
    this.emit();
  }
  stopRecordingTimeline(): void { this.recording = false; this.emit(); }
  clearTimeline(): void { this.timeline = []; this.emit(); }

  // ── Master FX ──────────────────────────────────────────────────────────────

  setMasterVolume(v: number): void {
    this.masterState.volume = Math.max(0, Math.min(1, v));
    this.masterGain.gain.setTargetAtTime(this.masterState.volume, this.ctx.currentTime, 0.01);
    this.emit();
  }
  setFilterFreq(hz: number): void { this.masterState.filterFreq = hz; this.filter.setFreq(hz); this.emit(); }
  setFilterEnabled(b: boolean): void { this.masterState.filterEnabled = b; this.filter.setBypassed(!b); this.emit(); }
  setEQ(band: 'low' | 'mid' | 'high', gainDB: number): void {
    if (band === 'low')  { this.masterState.eqLow  = gainDB; this.eq.setLow(gainDB); }
    if (band === 'mid')  { this.masterState.eqMid  = gainDB; this.eq.setMid(gainDB); }
    if (band === 'high') { this.masterState.eqHigh = gainDB; this.eq.setHigh(gainDB); }
    this.emit();
  }
  setCompStyle(style: CompressorStyle): void { this.masterState.compStyle = style; this.applyCompPreset(style); this.emit(); }
  setCompMix(mix: number): void {
    this.masterState.compMix = Math.max(0, Math.min(1, mix));
    this.compDryGain.gain.setTargetAtTime(1 - this.masterState.compMix, this.ctx.currentTime, 0.01);
    this.compWetGain.gain.setTargetAtTime(this.masterState.compMix, this.ctx.currentTime, 0.01);
    this.emit();
  }
  private applyCompPreset(style: CompressorStyle): void {
    const p = COMP_PRESETS[style];
    this.compressor.setDrive(p.drive);
    this.compressor.setRatio(p.ratio);
    this.compressor.setAttack(p.attack);
    this.compressor.setRelease(p.release);
    this.compressor.setMakeup(p.makeup);
    const targetMix = style === 'off' ? 0 : p.mix;
    if (style === 'off' || this.masterState.compMix === 0) this.masterState.compMix = targetMix;
    this.compDryGain.gain.setTargetAtTime(1 - this.masterState.compMix, this.ctx.currentTime, 0.01);
    this.compWetGain.gain.setTargetAtTime(this.masterState.compMix, this.ctx.currentTime, 0.01);
  }
  setDelayTime(s: number): void { this.masterState.delayTime = s; this.delay.setTimeL(s); this.delay.setTimeR(s * 1.5); this.emit(); }
  setDelayFeedback(v: number): void { this.masterState.delayFeedback = v; this.delay.setFeedback(v); this.emit(); }
  setDelayMix(v: number): void {
    this.masterState.delayMix = v; this.delay.setMix(v); this.delay.setBypassed(v <= 0.001); this.emit();
  }
  setReverbMix(v: number): void {
    this.masterState.reverbMix = v; this.reverb.setMix(v); this.reverb.setBypassed(v <= 0.001); this.emit();
  }
  setReverbDecay(s: number): void { this.masterState.reverbDecay = s; this.reverb.setDecay(s); this.emit(); }

  setBpm(bpm: number): void { this.bpm = bpm; this.emit(); }

  // ── Export ─────────────────────────────────────────────────────────────────

  async exportMaster(bitDepth: WAVBitDepth = 24): Promise<{ name: string; data: ArrayBuffer }> {
    if (!this.buffer) throw new Error('No track loaded');
    const events = this.timeline.length > 0 ? [...this.timeline] : this.defaultPlaybackEvents();
    if (events.length === 0) throw new Error('No assigned pads to render');

    let totalSec = 0;
    for (const e of events) totalSec = Math.max(totalSec, e.time + e.duration);
    totalSec += 0.5;
    const sr = this.buffer.sampleRate;
    const len = Math.ceil(totalSec * sr);
    const off = new OfflineAudioContext(2, len, sr);

    const { oFilter, oEq, oComp, oDelay, oReverb, oCompMixIn, oCompMixOut, oMasterGain, oLimiter, padBus } =
      this.buildOfflineChain(off);

    for (const e of events) {
      const pad = this.pads[e.padIdx];
      if (!pad || pad.chopId === null) continue;
      const chop = this.chops.find(c => c.id === pad.chopId);
      if (!chop) continue;
      const src = off.createBufferSource();
      src.buffer = this.buffer;
      src.detune.value = pad.pitch * 100;
      const g = off.createGain();
      g.gain.setValueAtTime(0, e.time);
      g.gain.linearRampToValueAtTime(1, e.time + 0.005);
      src.connect(g); g.connect(padBus);
      src.start(e.time, chop.start, chop.end - chop.start);
    }

    void oFilter; void oEq; void oComp; void oDelay; void oReverb;
    void oCompMixIn; void oCompMixOut; void oMasterGain; void oLimiter;

    const rendered = await off.startRendering();
    return { name: this.exportNameMaster(), data: encodeWAV(rendered, bitDepth) };
  }

  async exportChops(bitDepth: WAVBitDepth = 24): Promise<Array<{ name: string; data: ArrayBuffer }>> {
    if (!this.buffer) throw new Error('No track loaded');
    const out: Array<{ name: string; data: ArrayBuffer }> = [];
    for (const pad of this.pads) {
      if (pad.chopId === null) continue;
      const chop = this.chops.find(c => c.id === pad.chopId);
      if (!chop) continue;
      const data = await this.renderChopThroughMaster(chop, pad.pitch, bitDepth);
      out.push({ name: this.exportNameChop(pad.index + 1), data });
    }
    return out;
  }

  private buildOfflineChain(off: OfflineAudioContext) {
    const oFilter = new Filter(off);
    const oEq = new EQ3(off);
    const oComp = new Compressor(off);
    const oDelay = new Delay(off);
    const oReverb = new Reverb(off);

    oFilter.setType('lowpass');
    oFilter.setFreq(this.masterState.filterFreq);
    oFilter.setBypassed(!this.masterState.filterEnabled);
    oFilter.setMix(1);
    oEq.setLow(this.masterState.eqLow);
    oEq.setMid(this.masterState.eqMid);
    oEq.setHigh(this.masterState.eqHigh);
    const cp = COMP_PRESETS[this.masterState.compStyle];
    oComp.setDrive(cp.drive); oComp.setRatio(cp.ratio);
    oComp.setAttack(cp.attack); oComp.setRelease(cp.release); oComp.setMakeup(cp.makeup);
    oDelay.setTimeL(this.masterState.delayTime);
    oDelay.setTimeR(this.masterState.delayTime * 1.5);
    oDelay.setFeedback(this.masterState.delayFeedback);
    oDelay.setMix(this.masterState.delayMix);
    oDelay.setBypassed(this.masterState.delayMix <= 0.001);
    oReverb.setMix(this.masterState.reverbMix);
    oReverb.setDecay(this.masterState.reverbDecay);
    oReverb.setBypassed(this.masterState.reverbMix <= 0.001);

    const oCompMixIn = off.createGain();
    const oCompMixOut = off.createGain();
    const oCompDry = off.createGain();
    const oCompWet = off.createGain();
    oCompDry.gain.value = 1 - this.masterState.compMix;
    oCompWet.gain.value = this.masterState.compMix;
    oCompMixIn.connect(oCompDry);
    oCompMixIn.connect(oComp.input);
    oCompDry.connect(oCompMixOut);
    oComp.output.connect(oCompWet);
    oCompWet.connect(oCompMixOut);

    const oMasterGain = off.createGain();
    oMasterGain.gain.value = this.masterState.volume;
    const oLimiter = off.createDynamicsCompressor();
    oLimiter.threshold.value = -1; oLimiter.knee.value = 0;
    oLimiter.ratio.value = 20; oLimiter.attack.value = 0.001; oLimiter.release.value = 0.05;

    const padBus = off.createGain();
    padBus.connect(oFilter.input);
    oFilter.output.connect(oEq.input);
    oEq.output.connect(oCompMixIn);
    oCompMixOut.connect(oDelay.input);
    oDelay.output.connect(oReverb.input);
    oReverb.output.connect(oMasterGain);
    oMasterGain.connect(oLimiter);
    oLimiter.connect(off.destination);

    return { oFilter, oEq, oComp, oDelay, oReverb, oCompMixIn, oCompMixOut, oMasterGain, oLimiter, padBus };
  }

  private async renderChopThroughMaster(chop: Chop, pitch: number, bitDepth: WAVBitDepth): Promise<ArrayBuffer> {
    if (!this.buffer) throw new Error('No buffer');
    const dur = chop.end - chop.start;
    const sr = this.buffer.sampleRate;
    const tail = Math.max(0.3, this.masterState.reverbMix > 0 ? this.masterState.reverbDecay : 0.3);
    const len = Math.ceil((dur + tail) * sr);
    const off = new OfflineAudioContext(2, len, sr);

    const { padBus } = this.buildOfflineChain(off);
    const src = off.createBufferSource();
    src.buffer = this.buffer;
    src.detune.value = pitch * 100;
    src.connect(padBus);
    src.start(0, chop.start, dur);

    const rendered = await off.startRendering();
    return encodeWAV(rendered, bitDepth);
  }

  private defaultPlaybackEvents(): TimelineEvent[] {
    const events: TimelineEvent[] = [];
    let t = 0;
    for (const pad of this.pads) {
      if (pad.chopId === null) continue;
      const chop = this.chops.find(c => c.id === pad.chopId);
      if (!chop) continue;
      const dur = chop.end - chop.start;
      events.push({ padIdx: pad.index, time: t, duration: dur });
      t += dur;
    }
    return events;
  }

  private exportNameMaster(): string { return `${this.safeTitle()}_master`; }
  private exportNameChop(n: number): string {
    return `${this.safeTitle()}${this.bpm ? `_${Math.round(this.bpm)}BPM` : ''}_pad${String(n).padStart(2, '0')}`;
  }
  private safeTitle(): string {
    return (this.trackTitle || 'untitled').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 40);
  }

  dispose(): void {
    this.stopAllPads();
    if (this.metronomeTimer) clearInterval(this.metronomeTimer);
    try { this.ctx.close(); } catch { /* */ }
  }
}
