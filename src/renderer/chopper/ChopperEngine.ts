import { Filter } from '../audio/effects/Filter';
import { EQ3 } from '../audio/effects/EQ3';
import { Compressor } from '../audio/effects/Compressor';
import { Delay } from '../audio/effects/Delay';
import { Reverb } from '../audio/effects/Reverb';
import { encodeWAV, WAVBitDepth } from '../audio/StemExporter';

export type PadMode = 'oneshot' | 'loop';
export type CompressorStyle = 'off' | 'light' | 'punchy' | 'ny' | 'aggressive';

export interface Chop {
  id: number;
  start: number; // seconds within the master buffer
  end: number;   // seconds within the master buffer
}

export interface Pad {
  index: number;          // 0..15
  chopId: number | null;  // assigned chop, or null
  mode: PadMode;
  color: string;          // CSS color for UI
}

export interface TimelineEvent {
  padIdx: number;
  time: number;   // seconds since recording started
  duration: number;
}

const PAD_COLORS = [
  '#00ff88', '#00ccff', '#cc00ff', '#ff6600',
  '#ffcc00', '#ff0066', '#00ff00', '#ff00cc',
  '#33aaff', '#ff3333', '#88ff33', '#ff99cc',
  '#33ffcc', '#cc33ff', '#ffaa00', '#aa00ff',
];

// Drive-style compressor presets (DRIVE / RATIO / ATTACK ms / RELEASE ms / MAKEUP dB)
const COMP_PRESETS: Record<CompressorStyle, { drive: number; ratio: number; attack: number; release: number; makeup: number; mix: number }> = {
  off:        { drive: 0,  ratio: 1,  attack: 0.01,  release: 0.15, makeup: 0, mix: 0 },
  light:      { drive: 3,  ratio: 2,  attack: 0.030, release: 0.20, makeup: 2, mix: 1.0 },
  punchy:     { drive: 6,  ratio: 4,  attack: 0.010, release: 0.08, makeup: 4, mix: 1.0 },
  ny:         { drive: 12, ratio: 8,  attack: 0.001, release: 0.05, makeup: 6, mix: 0.5 },  // parallel
  aggressive: { drive: 18, ratio: 12, attack: 0.001, release: 0.03, makeup: 8, mix: 1.0 },
};

interface PadVoice {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

export interface ChopperState {
  hasBuffer: boolean;
  bufferDuration: number;
  trackTitle: string;
  bpm: number;
  chops: Chop[];
  pads: Pad[];
  selectedPad: number | null;     // for assignment mode
  master: {
    volume: number;               // 0..1
    filterFreq: number;           // 20..20000, lp
    filterEnabled: boolean;
    eqLow: number;                // dB
    eqMid: number;
    eqHigh: number;
    compStyle: CompressorStyle;
    compMix: number;              // 0..1
    delayTime: number;            // seconds
    delayFeedback: number;        // 0..0.95
    delayMix: number;
    reverbMix: number;
    reverbDecay: number;          // seconds
  };
  isLoaded: boolean;              // a buffer is loaded
  isLoading: boolean;             // download/decode in flight
  recording: boolean;
  timeline: TimelineEvent[];
}

export class ChopperEngine {
  readonly ctx: AudioContext;
  private masterGain: GainNode;
  private masterLimiter: DynamicsCompressorNode;

  // Master FX chain (linear, fixed order: filter → eq → comp → delay → reverb)
  private filter: Filter;
  private eq: EQ3;
  private compressor: Compressor;
  private compDryGain: GainNode;
  private compWetGain: GainNode;
  private compMixIn: GainNode;
  private compMixOut: GainNode;
  private delay: Delay;
  private reverb: Reverb;
  private padBus: GainNode; // every pad voice connects here

  buffer: AudioBuffer | null = null;
  trackTitle = '';
  bpm = 0;
  private chops: Chop[] = [];
  private pads: Pad[] = [];
  private nextChopId = 1;
  private voices: Map<number, PadVoice> = new Map();
  private selectedPad: number | null = null;

  // Timeline recording
  private recording = false;
  private recordStart = 0;
  private timeline: TimelineEvent[] = [];

  // Master state mirror (so UI can read it)
  private masterState: ChopperState['master'];

  private isLoading = false;
  private listeners = new Set<(s: ChopperState) => void>();

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

    this.filter      = new Filter(this.ctx);
    this.eq          = new EQ3(this.ctx);
    this.compressor  = new Compressor(this.ctx);
    this.delay       = new Delay(this.ctx);
    this.reverb      = new Reverb(this.ctx);

    // Compressor sits behind a parallel mix. compMixIn fans out to dry +
    // compressor; compMixOut sums them. The compressor's own bypass is left
    // off; we control wet/dry here so style preset 'ny' can do parallel comp.
    this.compMixIn  = this.ctx.createGain();
    this.compMixOut = this.ctx.createGain();
    this.compDryGain = this.ctx.createGain();
    this.compWetGain = this.ctx.createGain();
    this.compMixIn.connect(this.compDryGain);
    this.compMixIn.connect(this.compressor.input);
    this.compDryGain.connect(this.compMixOut);
    this.compressor.output.connect(this.compWetGain);
    this.compWetGain.connect(this.compMixOut);

    // Filter and EQ default to passthrough; bypass them initially
    this.filter.setBypassed(false); // filter active for cutoff sweep but we leave it open at 20k
    this.filter.setType('lowpass');
    this.filter.setFreq(20000);
    this.filter.setQ(6);
    this.filter.setMix(1);
    this.eq.setBypassed(false);
    this.eq.setLow(0);
    this.eq.setMid(0);
    this.eq.setHigh(0);

    this.delay.setBypassed(true);
    this.reverb.setBypassed(true);

    // padBus → filter → eq → [comp parallel] → delay → reverb → masterGain → masterLimiter → ctx.destination
    this.padBus = this.ctx.createGain();
    this.padBus.connect(this.filter.input);
    this.filter.output.connect(this.eq.input);
    this.eq.output.connect(this.compMixIn);
    this.compMixOut.connect(this.delay.input);
    this.delay.output.connect(this.reverb.input);
    this.reverb.output.connect(this.masterGain);
    this.masterGain.connect(this.masterLimiter);
    this.masterLimiter.connect(this.ctx.destination);

    // Initialize 16 pads
    this.pads = Array.from({ length: 16 }, (_, i) => ({
      index: i,
      chopId: null,
      mode: 'oneshot' as PadMode,
      color: PAD_COLORS[i],
    }));

    this.masterState = {
      volume: 0.85,
      filterFreq: 20000,
      filterEnabled: false,
      eqLow: 0, eqMid: 0, eqHigh: 0,
      compStyle: 'off',
      compMix: 0,
      delayTime: 0.25,
      delayFeedback: 0.3,
      delayMix: 0,
      reverbMix: 0,
      reverbDecay: 2,
    };
    this.applyCompPreset('off');
  }

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
    return {
      hasBuffer: this.buffer !== null,
      bufferDuration: this.buffer?.duration ?? 0,
      trackTitle: this.trackTitle,
      bpm: this.bpm,
      chops: [...this.chops],
      pads: this.pads.map(p => ({ ...p })),
      selectedPad: this.selectedPad,
      master: { ...this.masterState },
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
    // Default chop layout: 16 equal slices
    this.autoChop(16);
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
    // Pre-assign: pad i → chop i (1:1 for fast iteration)
    this.pads.forEach((p, i) => { p.chopId = i < this.chops.length ? this.chops[i].id : null; });
    this.emit();
  }

  setChopBoundary(chopId: number, side: 'start' | 'end', value: number): void {
    const c = this.chops.find(x => x.id === chopId);
    if (!c || !this.buffer) return;
    const v = Math.max(0, Math.min(this.buffer.duration, value));
    if (side === 'start') c.start = Math.min(v, c.end - 0.01);
    else c.end = Math.max(v, c.start + 0.01);
    this.emit();
  }

  // ── Pads ───────────────────────────────────────────────────────────────────

  selectPad(idx: number | null): void {
    this.selectedPad = idx;
    this.emit();
  }

  /** Click a chop on the waveform while a pad is selected → assign. */
  assignChopToPad(padIdx: number, chopId: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    pad.chopId = chopId;
    this.emit();
  }

  clearPad(padIdx: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    this.stopVoice(padIdx);
    pad.chopId = null;
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

  triggerPad(padIdx: number, velocity = 1): void {
    const pad = this.pads[padIdx];
    if (!pad || pad.chopId === null || !this.buffer) return;
    const chop = this.chops.find(c => c.id === pad.chopId);
    if (!chop) return;

    // If a voice is already playing for this pad, stop it (re-trigger).
    this.stopVoice(padIdx);

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = velocity;
    // Tiny attack/release fades to kill clicks
    const t = this.ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(velocity, t + 0.005);
    src.connect(gain);
    gain.connect(this.padBus);

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
        if (this.voices.get(padIdx)?.src === src) this.voices.delete(padIdx);
      };
    }

    this.voices.set(padIdx, { src, gain });

    if (this.recording) {
      this.timeline.push({
        padIdx,
        time: this.ctx.currentTime - this.recordStart,
        duration: chop.end - chop.start,
      });
      this.emit();
    }
  }

  releasePad(padIdx: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    // Loops keep playing until explicit release; oneshots end on their own.
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
  }

  stopAllPads(): void {
    for (const idx of [...this.voices.keys()]) this.stopVoice(idx);
  }

  // ── Timeline recording ─────────────────────────────────────────────────────

  startRecordingTimeline(): void {
    this.timeline = [];
    this.recording = true;
    this.recordStart = this.ctx.currentTime;
    this.emit();
  }
  stopRecordingTimeline(): void {
    this.recording = false;
    this.emit();
  }
  clearTimeline(): void {
    this.timeline = [];
    this.emit();
  }

  // ── Master FX ──────────────────────────────────────────────────────────────

  setMasterVolume(v: number): void {
    this.masterState.volume = Math.max(0, Math.min(1, v));
    this.masterGain.gain.setTargetAtTime(this.masterState.volume, this.ctx.currentTime, 0.01);
    this.emit();
  }
  setFilterFreq(hz: number): void {
    this.masterState.filterFreq = hz;
    this.filter.setFreq(hz);
    this.emit();
  }
  setFilterEnabled(b: boolean): void {
    this.masterState.filterEnabled = b;
    this.filter.setBypassed(!b);
    this.emit();
  }
  setEQ(band: 'low' | 'mid' | 'high', gainDB: number): void {
    if (band === 'low')  { this.masterState.eqLow  = gainDB; this.eq.setLow(gainDB); }
    if (band === 'mid')  { this.masterState.eqMid  = gainDB; this.eq.setMid(gainDB); }
    if (band === 'high') { this.masterState.eqHigh = gainDB; this.eq.setHigh(gainDB); }
    this.emit();
  }
  setCompStyle(style: CompressorStyle): void {
    this.masterState.compStyle = style;
    this.applyCompPreset(style);
    this.emit();
  }
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
    // Style preset suggests a default mix, but the user-set mix wins if non-off
    const targetMix = style === 'off' ? 0 : p.mix;
    if (style === 'off' || this.masterState.compMix === 0) {
      this.masterState.compMix = targetMix;
    }
    this.compDryGain.gain.setTargetAtTime(1 - this.masterState.compMix, this.ctx.currentTime, 0.01);
    this.compWetGain.gain.setTargetAtTime(this.masterState.compMix, this.ctx.currentTime, 0.01);
  }
  setDelayTime(s: number): void {
    this.masterState.delayTime = s;
    this.delay.setTimeL(s);
    this.delay.setTimeR(s * 1.5);
    this.emit();
  }
  setDelayFeedback(v: number): void {
    this.masterState.delayFeedback = v;
    this.delay.setFeedback(v);
    this.emit();
  }
  setDelayMix(v: number): void {
    this.masterState.delayMix = v;
    this.delay.setMix(v);
    this.delay.setBypassed(v <= 0.001);
    this.emit();
  }
  setReverbMix(v: number): void {
    this.masterState.reverbMix = v;
    this.reverb.setMix(v);
    this.reverb.setBypassed(v <= 0.001);
    this.emit();
  }
  setReverbDecay(s: number): void {
    this.masterState.reverbDecay = s;
    this.reverb.setDecay(s);
    this.emit();
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  /** Render the recorded timeline through the master FX chain into a single
   *  WAV. If timeline is empty, renders a single pass of every assigned pad in
   *  pad order, back-to-back — that gives a quick sketch even without manual
   *  arrangement. */
  async exportMaster(bitDepth: WAVBitDepth = 24): Promise<{ name: string; data: ArrayBuffer }> {
    if (!this.buffer) throw new Error('No track loaded');
    const events = this.timeline.length > 0 ? [...this.timeline] : this.defaultPlaybackEvents();
    if (events.length === 0) throw new Error('No assigned pads to render');

    // Determine total length
    let totalSec = 0;
    for (const e of events) totalSec = Math.max(totalSec, e.time + e.duration);
    totalSec += 0.5; // tail
    const sr = this.buffer.sampleRate;
    const len = Math.ceil(totalSec * sr);
    const off = new OfflineAudioContext(2, len, sr);

    // Rebuild master FX inside the offline context
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
    oComp.setDrive(cp.drive);
    oComp.setRatio(cp.ratio);
    oComp.setAttack(cp.attack);
    oComp.setRelease(cp.release);
    oComp.setMakeup(cp.makeup);
    oDelay.setTimeL(this.masterState.delayTime);
    oDelay.setTimeR(this.masterState.delayTime * 1.5);
    oDelay.setFeedback(this.masterState.delayFeedback);
    oDelay.setMix(this.masterState.delayMix);
    oDelay.setBypassed(this.masterState.delayMix <= 0.001);
    oReverb.setMix(this.masterState.reverbMix);
    oReverb.setDecay(this.masterState.reverbDecay);
    oReverb.setBypassed(this.masterState.reverbMix <= 0.001);

    // Compressor parallel mix
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
    oLimiter.threshold.value = -1;
    oLimiter.knee.value = 0;
    oLimiter.ratio.value = 20;
    oLimiter.attack.value = 0.001;
    oLimiter.release.value = 0.05;

    const padBus = off.createGain();
    padBus.connect(oFilter.input);
    oFilter.output.connect(oEq.input);
    oEq.output.connect(oCompMixIn);
    oCompMixOut.connect(oDelay.input);
    oDelay.output.connect(oReverb.input);
    oReverb.output.connect(oMasterGain);
    oMasterGain.connect(oLimiter);
    oLimiter.connect(off.destination);

    // Schedule all timeline events
    for (const e of events) {
      const pad = this.pads[e.padIdx];
      if (!pad || pad.chopId === null) continue;
      const chop = this.chops.find(c => c.id === pad.chopId);
      if (!chop) continue;
      const src = off.createBufferSource();
      src.buffer = this.buffer;
      const g = off.createGain();
      g.gain.setValueAtTime(0, e.time);
      g.gain.linearRampToValueAtTime(1, e.time + 0.005);
      src.connect(g);
      g.connect(padBus);
      src.start(e.time, chop.start, chop.end - chop.start);
    }

    const rendered = await off.startRendering();
    const data = encodeWAV(rendered, bitDepth);
    return { name: this.exportNameMaster(), data };
  }

  /** Render each assigned pad's chop through the master FX chain individually.
   *  Useful for dropping the chops onto an MPC for performance use. Each
   *  chop name is "<title>_<bpm>BPM_pad<N>". */
  async exportChops(bitDepth: WAVBitDepth = 24): Promise<Array<{ name: string; data: ArrayBuffer }>> {
    if (!this.buffer) throw new Error('No track loaded');
    const out: Array<{ name: string; data: ArrayBuffer }> = [];
    for (const pad of this.pads) {
      if (pad.chopId === null) continue;
      const chop = this.chops.find(c => c.id === pad.chopId);
      if (!chop) continue;
      const data = await this.renderChopThroughMaster(chop, bitDepth);
      out.push({ name: this.exportNameChop(pad.index + 1), data });
    }
    return out;
  }

  private async renderChopThroughMaster(chop: Chop, bitDepth: WAVBitDepth): Promise<ArrayBuffer> {
    if (!this.buffer) throw new Error('No buffer');
    const dur = chop.end - chop.start;
    const sr = this.buffer.sampleRate;
    const tail = Math.max(0.3, this.masterState.reverbMix > 0 ? this.masterState.reverbDecay : 0.3);
    const len = Math.ceil((dur + tail) * sr);
    const off = new OfflineAudioContext(2, len, sr);

    const oFilter = new Filter(off);
    const oEq = new EQ3(off);
    const oComp = new Compressor(off);
    const oDelay = new Delay(off);
    const oReverb = new Reverb(off);
    oFilter.setType('lowpass');
    oFilter.setFreq(this.masterState.filterFreq);
    oFilter.setBypassed(!this.masterState.filterEnabled);
    oEq.setLow(this.masterState.eqLow);
    oEq.setMid(this.masterState.eqMid);
    oEq.setHigh(this.masterState.eqHigh);
    const cp = COMP_PRESETS[this.masterState.compStyle];
    oComp.setDrive(cp.drive); oComp.setRatio(cp.ratio); oComp.setAttack(cp.attack);
    oComp.setRelease(cp.release); oComp.setMakeup(cp.makeup);
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

    oFilter.output.connect(oEq.input);
    oEq.output.connect(oCompMixIn);
    oCompMixOut.connect(oDelay.input);
    oDelay.output.connect(oReverb.input);
    oReverb.output.connect(oMasterGain);
    oMasterGain.connect(off.destination);

    const src = off.createBufferSource();
    src.buffer = this.buffer;
    src.connect(oFilter.input);
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

  private exportNameMaster(): string {
    return `${this.safeTitle()}_master`;
  }
  private exportNameChop(n: number): string {
    return `${this.safeTitle()}${this.bpm ? `_${Math.round(this.bpm)}BPM` : ''}_pad${String(n).padStart(2, '0')}`;
  }
  private safeTitle(): string {
    return (this.trackTitle || 'untitled').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 40);
  }

  setBpm(bpm: number): void {
    this.bpm = bpm;
    this.emit();
  }

  dispose(): void {
    this.stopAllPads();
    try { this.ctx.close(); } catch { /* */ }
  }
}
