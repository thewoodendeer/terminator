import { Waveshaper } from './effects/Waveshaper';
import { MultibandSaturator } from './effects/MultibandSaturator';
import { OTT } from './effects/OTT';
import { StereoWidener } from './effects/StereoWidener';
import { MSEQ } from './effects/MSEQ';
import { Reverb } from './effects/Reverb';
import { Delay } from './effects/Delay';
import { EQ3 } from './effects/EQ3';
import { Clipper } from './effects/Clipper';
import { Chorus } from './effects/Chorus';
import { BitCrusher } from './effects/BitCrusher';
import { AutoPan } from './effects/AutoPan';
import { TranceGate } from './effects/TranceGate';
import { Filter, FilterType } from './effects/Filter';

let trackCounter = 0;

export type EffectKey =
  | 'filter' | 'eq' | 'clipper' | 'waveshaper' | 'saturator' | 'ott'
  | 'widener' | 'mseq' | 'chorus' | 'delay' | 'reverb'
  | 'bitcrusher' | 'autopan' | 'trancegate';

export const DEFAULT_FX_ORDER: EffectKey[] = [
  'filter', 'eq', 'clipper', 'waveshaper', 'saturator', 'ott',
  'widener', 'mseq', 'chorus', 'delay', 'reverb',
  'bitcrusher', 'autopan', 'trancegate',
];

export interface TrackEffectsState {
  filter:     { type: FilterType; freq: number; q: number; mix: number; bypassed: boolean };
  eq:         { lowGain: number; midGain: number; highGain: number; bypassed: boolean };
  clipper:    { amount: number; drive: number; mix: number; bypassed: boolean };
  waveshaper: { drive: number; mix: number; bypassed: boolean };
  saturator:  { drive: number; mix: number; lowFreq: number; highFreq: number; bypassed: boolean };
  ott:        { depth: number; mix: number; bypassed: boolean };
  widener:    { width: number; mix: number; bypassed: boolean };
  mseq:       { midFreq: number; midGain: number; sideFreq: number; sideGain: number; mix: number; bypassed: boolean };
  chorus:     { rate: number; depth: number; mix: number; bypassed: boolean };
  delay:      { timeL: number; timeR: number; feedback: number; mix: number; pingPong: boolean; bypassed: boolean };
  reverb:     { mix: number; decay: number; preHPF: number; bypassed: boolean };
  bitcrusher: { bits: number; rate: number; mix: number; bypassed: boolean };
  autopan:    { rate: number; depth: number; mix: number; bypassed: boolean };
  trancegate: { rate: number; depth: number; attack: number; release: number; mix: number; synced: boolean; syncDiv: string; bypassed: boolean };
  masterBypass: boolean;
  effectsOrder: EffectKey[];
}

export interface TrackState {
  id: string;
  name: string;
  volume: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  armed: boolean;
  midiArmed: boolean;
  rootNote: number;
  reversed: boolean;
  timeStretch: number;
  pitch: number;
  loopStartOffset: number;
  quantizeEnabled: boolean;
  quantizeGrid: string;
  swingAmount: number;
  effects: TrackEffectsState;
  hasAudio: boolean;
  bufferDuration: number;
  waveformPeaks: number[];
  color: string;
}

export class Track {
  readonly id: string;
  name: string;
  buffer: AudioBuffer | null = null;
  private reversedBuffer: AudioBuffer | null = null;

  readonly gainNode: GainNode;
  readonly panNode: StereoPannerNode;
  private loopGain: GainNode; // dedicated gain for loop sources — faded in/out at bar boundaries
  private fxInputGain: GainNode;
  private fxOutGain: GainNode;
  private dryBypassGain: GainNode;
  private sourceNode: AudioBufferSourceNode | null = null;
  private pendingStops = new Set<AudioBufferSourceNode>();
  private monitorSource: MediaStreamAudioSourceNode | null = null;

  readonly filter:     Filter;
  readonly eq:         EQ3;
  readonly clipper:    Clipper;
  readonly waveshaper: Waveshaper;
  readonly saturator:  MultibandSaturator;
  readonly ott:        OTT;
  readonly widener:    StereoWidener;
  readonly mseq:       MSEQ;
  readonly chorus:     Chorus;
  readonly delay:      Delay;
  readonly reverb:     Reverb;
  readonly bitcrusher: BitCrusher;
  readonly autopan:    AutoPan;
  readonly trancegate: TranceGate;

  volume  = 0.8;
  pan     = 0;
  muted   = false;
  soloed  = false;
  armed   = false;
  midiArmed = false;
  rootNote  = 60;
  reversed = false;
  private midiSources = new Map<number, { src: AudioBufferSourceNode; vel: GainNode }>();
  timeStretch     = 1.0;
  pitch           = 0;
  loopStartOffset = 0;
  quantizeEnabled = false;
  quantizeGrid    = '1/16';
  swingAmount     = 50;
  masterBypass    = false;
  color: string;
  effectsOrder: EffectKey[] = [...DEFAULT_FX_ORDER];
  waveformPeaks: number[]   = [];

  static readonly COLORS = ['#00ff88','#00ccff','#ff6600','#cc00ff','#ffcc00','#ff0066','#00ff00','#ff00cc'];

  constructor(private ctx: AudioContext, private destination: AudioNode) {
    trackCounter++;
    this.id    = `track-${Date.now()}-${trackCounter}`;
    this.name  = `TRACK ${trackCounter}`;
    this.color = Track.COLORS[(trackCounter - 1) % Track.COLORS.length];

    this.gainNode      = ctx.createGain();
    this.gainNode.gain.value = this.volume;
    this.loopGain      = ctx.createGain();
    this.loopGain.gain.value = 1;
    this.loopGain.connect(this.gainNode);
    this.panNode       = ctx.createStereoPanner();
    this.panNode.pan.value = this.pan;
    this.fxInputGain   = ctx.createGain();
    this.fxOutGain     = ctx.createGain();
    this.fxOutGain.gain.value = 1;
    this.dryBypassGain = ctx.createGain();
    this.dryBypassGain.gain.value = 0;

    this.filter     = new Filter(ctx);
    this.eq         = new EQ3(ctx);
    this.clipper    = new Clipper(ctx);
    this.waveshaper = new Waveshaper(ctx);
    this.saturator  = new MultibandSaturator(ctx);
    this.ott        = new OTT(ctx);
    this.widener    = new StereoWidener(ctx);
    this.mseq       = new MSEQ(ctx);
    this.chorus     = new Chorus(ctx);
    this.delay      = new Delay(ctx);
    this.reverb     = new Reverb(ctx);
    this.bitcrusher = new BitCrusher(ctx);
    this.autopan    = new AutoPan(ctx);
    this.trancegate = new TranceGate(ctx);

    // All effects start bypassed
    this.filter.setBypassed(true);
    this.eq.setBypassed(true);
    this.clipper.setBypassed(true);
    this.waveshaper.setBypassed(true);
    this.saturator.setBypassed(true);
    this.ott.setBypassed(true);
    this.chorus.setBypassed(true);
    this.delay.setBypassed(true);
    this.reverb.setBypassed(true);
    this.autopan.setBypassed(true);

    this.gainNode.connect(this.fxInputGain);
    this.gainNode.connect(this.dryBypassGain);
    this.rewireEffects();
    this.fxOutGain.connect(this.panNode);
    this.dryBypassGain.connect(this.panNode);
    this.panNode.connect(this.destination);
  }

  async initWorklets(): Promise<void> {
    await Promise.all([
      this.widener.init(),
      this.mseq.init(),
      this.bitcrusher.init(),
      this.trancegate.init(),
    ]);
    this.widener.setBypassed(true);
    this.mseq.setBypassed(true);
    this.bitcrusher.setBypassed(true);
    this.trancegate.setBypassed(true);
  }

  private effectIO(key: EffectKey): { input: AudioNode; output: AudioNode } {
    switch (key) {
      case 'filter':     return this.filter;
      case 'eq':         return this.eq;
      case 'clipper':    return this.clipper;
      case 'waveshaper': return this.waveshaper;
      case 'saturator':  return this.saturator;
      case 'ott':        return this.ott;
      case 'widener':    return this.widener;
      case 'mseq':       return this.mseq;
      case 'chorus':     return this.chorus;
      case 'delay':      return this.delay;
      case 'reverb':     return this.reverb;
      case 'bitcrusher': return this.bitcrusher;
      case 'autopan':    return this.autopan;
      case 'trancegate': return this.trancegate;
    }
  }

  rewireEffects(): void {
    try { this.fxInputGain.disconnect(); } catch (_) {}
    for (const key of DEFAULT_FX_ORDER) {
      try { (this.effectIO(key).output as GainNode).disconnect(); } catch (_) {}
    }
    const order = this.effectsOrder;
    if (order.length === 0) { this.fxInputGain.connect(this.fxOutGain); return; }
    this.fxInputGain.connect(this.effectIO(order[0]).input);
    for (let i = 0; i < order.length - 1; i++) {
      this.effectIO(order[i]).output.connect(this.effectIO(order[i + 1]).input);
    }
    this.effectIO(order[order.length - 1]).output.connect(this.fxOutGain);
  }

  reorderEffects(order: EffectKey[]): void {
    this.effectsOrder = [...order];
    this.rewireEffects();
  }

  setEffectBypassed(fx: EffectKey, b: boolean): void {
    switch (fx) {
      case 'filter':     this.filter.setBypassed(b);     break;
      case 'eq':         this.eq.setBypassed(b);         break;
      case 'clipper':    this.clipper.setBypassed(b);    break;
      case 'waveshaper': this.waveshaper.setBypassed(b); break;
      case 'saturator':  this.saturator.setBypassed(b);  break;
      case 'ott':        this.ott.setBypassed(b);        break;
      case 'widener':    this.widener.setBypassed(b);    break;
      case 'mseq':       this.mseq.setBypassed(b);       break;
      case 'chorus':     this.chorus.setBypassed(b);     break;
      case 'delay':      this.delay.setBypassed(b);      break;
      case 'reverb':     this.reverb.setBypassed(b);     break;
      case 'bitcrusher': this.bitcrusher.setBypassed(b); break;
      case 'autopan':    this.autopan.setBypassed(b);    break;
      case 'trancegate': this.trancegate.setBypassed(b); break;
    }
  }

  setMasterBypass(b: boolean): void {
    this.masterBypass = b;
    this.fxOutGain.gain.setTargetAtTime(b ? 0 : 1, this.ctx.currentTime, 0.005);
    this.dryBypassGain.gain.setTargetAtTime(b ? 1 : 0, this.ctx.currentTime, 0.005);
  }

  setReversed(reversed: boolean): void {
    this.reversed = reversed;
    this.stop();
  }

  setBPM(bpm: number): void {
    this.trancegate.setBPM(bpm);
  }

  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
    this.reversedBuffer = Track.reverseBuffer(buffer, this.ctx);
    this.loopStartOffset = 0;
    this.waveformPeaks = Track.computePeaks(buffer, 2000);
  }

  private static reverseBuffer(buf: AudioBuffer, ctx: AudioContext): AudioBuffer {
    const rev = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c).slice().reverse();
      rev.copyToChannel(data, c);
    }
    return rev;
  }

  private static computePeaks(buffer: AudioBuffer, columns: number): number[] {
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / columns));
    const peaks: number[] = [];
    for (let i = 0; i < columns; i++) {
      let mn = 0, mx = 0;
      const base = i * step;
      for (let j = 0; j < step && base + j < data.length; j++) {
        const s = data[base + j];
        if (s < mn) mn = s;
        if (s > mx) mx = s;
      }
      peaks.push(mn, mx);
    }
    return peaks;
  }

  private static readonly FADE = 0.004; // 4 ms — enough to kill clicks, short enough to be inaudible

  play(startTime: number, loopDuration: number, offsetIntoLoop = 0): void {
    this.stop();
    if (this.muted) return;
    const buf = this.reversed && this.reversedBuffer ? this.reversedBuffer : this.buffer;
    if (!buf) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = false;
    src.playbackRate.value = this.timeStretch;
    src.detune.value       = this.pitch * 100;
    src.connect(this.loopGain);

    // Fade in from silence at sample start to eliminate transient click
    this.loopGain.gain.cancelScheduledValues(startTime);
    this.loopGain.gain.setValueAtTime(0, startTime);
    this.loopGain.gain.linearRampToValueAtTime(1, startTime + Track.FADE);

    if (this.reversed) {
      src.start(startTime, 0);
    } else {
      const regionLen = Math.max(0.001,
        Math.min(buf.duration - this.loopStartOffset, loopDuration * this.timeStretch));
      const safeOffset = (offsetIntoLoop * this.timeStretch) % regionLen;
      src.start(startTime, this.loopStartOffset + safeOffset);
    }
    this.sourceNode = src;
  }

  // Called by the engine's bar-boundary lookahead scheduler
  scheduleRetrigger(atTime: number): void {
    if (!this.buffer || this.muted) return;
    const buf = this.reversed && this.reversedBuffer ? this.reversedBuffer : this.buffer;
    const F   = Track.FADE;

    // Fade out the current source just before the bar boundary, then stop it
    const old = this.sourceNode;
    if (old) {
      this.loopGain.gain.cancelScheduledValues(atTime - F);
      this.loopGain.gain.setValueAtTime(1, atTime - F);
      this.loopGain.gain.linearRampToValueAtTime(0, atTime);
      try { old.stop(atTime); } catch (_) {}
      old.onended = () => { try { old.disconnect(); } catch (_) {} this.pendingStops.delete(old); };
      this.pendingStops.add(old);
      this.sourceNode = null;
    }

    // Schedule a new source starting at the bar boundary with a fade in
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = false;
    src.playbackRate.value = this.timeStretch;
    src.detune.value       = this.pitch * 100;
    src.connect(this.loopGain);
    this.loopGain.gain.setValueAtTime(0, atTime);
    this.loopGain.gain.linearRampToValueAtTime(1, atTime + F);
    src.start(atTime, this.reversed ? 0 : this.loopStartOffset);
    this.sourceNode = src;
  }

  stop(): void {
    for (const src of this.pendingStops) {
      try { src.stop(); } catch (_) {}
      try { src.disconnect(); } catch (_) {}
    }
    this.pendingStops.clear();
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch (_) {}
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
  }

  startMonitoring(stream: MediaStream): void {
    this.stopMonitoring();
    this.monitorSource = this.ctx.createMediaStreamSource(stream) as MediaStreamAudioSourceNode;
    this.monitorSource.connect(this.gainNode);
  }

  stopMonitoring(): void {
    if (this.monitorSource) {
      this.monitorSource.disconnect();
      this.monitorSource = null;
    }
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.gainNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
  }

  setPan(p: number): void {
    this.pan = Math.max(-1, Math.min(1, p));
    this.panNode.pan.setTargetAtTime(this.pan, this.ctx.currentTime, 0.01);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (m && this.sourceNode) this.stop();
  }

  setTimeStretch(rate: number): void {
    this.timeStretch = Math.max(0.25, Math.min(4, rate));
    if (this.sourceNode) {
      this.sourceNode.playbackRate.setTargetAtTime(this.timeStretch, this.ctx.currentTime, 0.01);
    }
  }

  setPitch(semitones: number): void {
    this.pitch = Math.max(-24, Math.min(24, semitones));
    if (this.sourceNode) {
      this.sourceNode.detune.setTargetAtTime(this.pitch * 100, this.ctx.currentTime, 0.01);
    }
  }

  setLoopStartOffset(offset: number): void {
    this.loopStartOffset = Math.max(0, Math.min(this.buffer ? this.buffer.duration * 0.95 : 0, offset));
  }

  setRootNote(note: number): void {
    this.rootNote = Math.max(0, Math.min(127, note));
  }

  playNote(midiNote: number, velocity: number): void {
    if (!this.buffer || this.muted) return;
    this.stopNote(midiNote);
    const buf = this.reversed && this.reversedBuffer ? this.reversedBuffer : this.buffer;

    const vel = this.ctx.createGain();
    vel.gain.value = velocity / 127;
    vel.connect(this.gainNode);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = this.reversed ? 0 : this.loopStartOffset;
    src.loopEnd   = buf.duration;
    src.playbackRate.value = this.timeStretch;
    src.detune.value = (midiNote - this.rootNote) * 100 + this.pitch * 100;
    src.connect(vel);
    src.start(0, this.reversed ? 0 : this.loopStartOffset);
    src.onended = () => { vel.disconnect(); this.midiSources.delete(midiNote); };
    this.midiSources.set(midiNote, { src, vel });
  }

  stopNote(midiNote: number): void {
    const entry = this.midiSources.get(midiNote);
    if (!entry) return;
    const { src, vel } = entry;
    // Short fade-out to avoid clicks
    vel.gain.setTargetAtTime(0, this.ctx.currentTime, 0.015);
    try { src.stop(this.ctx.currentTime + 0.08); } catch (_) {}
    this.midiSources.delete(midiNote);
  }

  stopAllNotes(): void {
    for (const note of [...this.midiSources.keys()]) this.stopNote(note);
  }

  stretchToFit(loopDuration: number): void {
    if (!this.buffer || loopDuration <= 0) return;
    this.setTimeStretch(this.buffer.duration / loopDuration);
  }

  getState(): TrackState {
    return {
      id: this.id,
      name: this.name,
      volume: this.volume,
      pan: this.pan,
      muted: this.muted,
      soloed: this.soloed,
      armed: this.armed,
      midiArmed: this.midiArmed,
      rootNote:  this.rootNote,
      reversed: this.reversed,
      timeStretch: this.timeStretch,
      pitch: this.pitch,
      loopStartOffset: this.loopStartOffset,
      quantizeEnabled: this.quantizeEnabled,
      quantizeGrid: this.quantizeGrid,
      swingAmount: this.swingAmount,
      effects: {
        filter:     { type: this.filter.type, freq: this.filter.freq, q: this.filter.q, mix: this.filter.mix, bypassed: this.filter.bypassed },
        eq:         { lowGain: this.eq.lowGain, midGain: this.eq.midGain, highGain: this.eq.highGain, bypassed: this.eq.bypassed },
        clipper:    { amount: this.clipper.amount, drive: this.clipper.drive, mix: this.clipper.mix, bypassed: this.clipper.bypassed },
        waveshaper: { drive: this.waveshaper.drive, mix: this.waveshaper.mix, bypassed: this.waveshaper.bypassed },
        saturator:  { drive: this.saturator.drive, mix: this.saturator.mix, lowFreq: this.saturator.lowFreq, highFreq: this.saturator.highFreq, bypassed: this.saturator.bypassed },
        ott:        { depth: this.ott.depth, mix: this.ott.mix, bypassed: this.ott.bypassed },
        widener:    { width: this.widener.width, mix: this.widener.mix, bypassed: this.widener.bypassed },
        mseq:       { midFreq: this.mseq.midFreq, midGain: this.mseq.midGain, sideFreq: this.mseq.sideFreq, sideGain: this.mseq.sideGain, mix: this.mseq.mix, bypassed: this.mseq.bypassed },
        chorus:     { rate: this.chorus.rate, depth: this.chorus.depth, mix: this.chorus.mix, bypassed: this.chorus.bypassed },
        delay:      { timeL: this.delay.timeL, timeR: this.delay.timeR, feedback: this.delay.feedback, mix: this.delay.mix, pingPong: this.delay.pingPong, bypassed: this.delay.bypassed },
        reverb:     { mix: this.reverb.mix, decay: this.reverb.decay, preHPF: this.reverb.preHPFFreq, bypassed: this.reverb.bypassed },
        bitcrusher: { bits: this.bitcrusher.bits, rate: this.bitcrusher.rate, mix: this.bitcrusher.mix, bypassed: this.bitcrusher.bypassed },
        autopan:    { rate: this.autopan.rate, depth: this.autopan.depth, mix: this.autopan.mix, bypassed: this.autopan.bypassed },
        trancegate: { rate: this.trancegate.rate, depth: this.trancegate.depth, attack: this.trancegate.attack, release: this.trancegate.release, mix: this.trancegate.mix, synced: this.trancegate.synced, syncDiv: this.trancegate.syncDiv, bypassed: this.trancegate.bypassed },
        masterBypass: this.masterBypass,
        effectsOrder: [...this.effectsOrder],
      },
      hasAudio: this.buffer !== null,
      bufferDuration: this.buffer?.duration ?? 0,
      waveformPeaks: this.waveformPeaks,
      color: this.color,
    };
  }

  clone(destination: AudioNode): Track {
    const t = new Track(this.ctx, destination);
    t.name = `${this.name} CPY`;
    if (this.buffer) {
      t.buffer = this.buffer;
      t.reversedBuffer = this.reversedBuffer;
      t.waveformPeaks = this.waveformPeaks;
    }
    t.setVolume(this.volume);
    t.setPan(this.pan);
    t.timeStretch   = this.timeStretch;
    t.pitch         = this.pitch;
    t.reversed      = this.reversed;
    t.effectsOrder  = [...this.effectsOrder];
    t.waveshaper.setDrive(this.waveshaper.drive);
    t.waveshaper.setMix(this.waveshaper.mix);
    t.saturator.setDrive(this.saturator.drive);
    t.saturator.setMix(this.saturator.mix);
    t.ott.setDepth(this.ott.depth);
    t.ott.setMix(this.ott.mix);
    t.reverb.setMix(this.reverb.mix);
    t.reverb.setDecay(this.reverb.decay);
    t.delay.setTimeL(this.delay.timeL);
    t.delay.setTimeR(this.delay.timeR);
    t.delay.setFeedback(this.delay.feedback);
    t.delay.setMix(this.delay.mix);
    return t;
  }

  dispose(): void {
    this.stop();
    this.stopMonitoring();
    this.stopAllNotes();
    this.chorus.dispose();
    this.autopan.dispose();
    this.trancegate.dispose();
    this.gainNode.disconnect();
    this.panNode.disconnect();
  }
}
