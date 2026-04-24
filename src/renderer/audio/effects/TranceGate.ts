export type TranceGateSyncDiv =
  | '1/2' | '1/4' | '1/8' | '1/16' | '1/32' | '1/64' | '1/128';

const DIV_FACTORS: Record<TranceGateSyncDiv, number> = {
  '1/2': 2, '1/4': 4, '1/8': 8, '1/16': 16, '1/32': 32, '1/64': 64, '1/128': 128,
};

export class TranceGate {
  readonly input:  GainNode;
  readonly output: GainNode;

  // signal path
  private dryGain:   GainNode;
  private wetMixer:  GainNode;
  private wetGain:   GainNode;
  private gateGain:  GainNode;
  private floorGain: GainNode;

  // LFO chain
  private lfo:       OscillatorNode;
  private lfoShaper: WaveShaperNode;
  private smoother:  BiquadFilterNode; // rounds square-wave edges to kill clicks
  private lfoDepth:  GainNode;

  private _rate     = 4;
  private _depth    = 1;
  private _attack   = 0.005;
  private _release  = 0.08;
  private _mix      = 1;
  private _bypassed = false;
  private _synced   = false;
  private _syncDiv: TranceGateSyncDiv = '1/8';
  private _bpm      = 140;

  constructor(private ctx: AudioContext) {
    this.input    = ctx.createGain();
    this.output   = ctx.createGain();
    this.dryGain  = ctx.createGain();
    this.wetMixer = ctx.createGain();
    this.wetGain  = ctx.createGain();

    // gateGain.gain is modulated by LFO → produces 0..depth of the signal
    this.gateGain  = ctx.createGain();
    this.gateGain.gain.value = 0;

    // floorGain passes a constant (1-depth) of the signal through
    // Combined: output = gateGain(input) + floorGain(input) = input * (lfo01*depth + (1-depth))
    this.floorGain = ctx.createGain();
    this.floorGain.gain.value = 1 - this._depth;

    // Square wave LFO (-1 / +1)
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'square';
    this.lfo.frequency.value = this._rate;

    // Remap [-1, 1] → [0, 1]
    this.lfoShaper = ctx.createWaveShaper();
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = i / (n - 1);
    this.lfoShaper.curve = curve;

    // Lowpass smoother: rounds the 0/1 square edges, eliminating clicks
    // Cutoff ≈ 0.35/attack — ~5 ms rise for default attack of 0.005s
    this.smoother = ctx.createBiquadFilter();
    this.smoother.type = 'lowpass';
    this.smoother.frequency.value = this._attackToCutoff(this._attack);

    // Scale remapped LFO by depth → adds 0..depth to gateGain.gain
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = this._depth;

    // LFO → shaper → smoother → lfoDepth → gateGain.gain (modulation)
    this.lfo.connect(this.lfoShaper);
    this.lfoShaper.connect(this.smoother);
    this.smoother.connect(this.lfoDepth);
    this.lfoDepth.connect(this.gateGain.gain);

    // Signal path: dry + wet
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    this.input.connect(this.gateGain);
    this.input.connect(this.floorGain);
    this.gateGain.connect(this.wetMixer);
    this.floorGain.connect(this.wetMixer);
    this.wetMixer.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.setMix(this._mix);

    this.lfo.start();
  }

  setRate(v: number): void {
    this._rate = Math.max(0.1, Math.min(40, v));
    if (!this._synced) this.lfo.frequency.setTargetAtTime(this._rate, this.ctx.currentTime, 0.01);
  }

  setDepth(v: number): void {
    this._depth = Math.max(0, Math.min(1, v));
    this.lfoDepth.gain.setTargetAtTime(this._depth, this.ctx.currentTime, 0.01);
    this.floorGain.gain.setTargetAtTime(1 - this._depth, this.ctx.currentTime, 0.01);
  }

  setAttack(v: number): void {
    this._attack = Math.max(0.001, Math.min(0.5, v));
    this.smoother.frequency.setTargetAtTime(this._attackToCutoff(this._attack), this.ctx.currentTime, 0.01);
  }
  setRelease(v: number): void { this._release = Math.max(0.001, Math.min(0.5, v)); }

  private _attackToCutoff(attack: number): number {
    // 0.35/attack converts attack time → smoothing bandwidth; cap at 500 Hz
    return Math.min(0.35 / Math.max(attack, 0.001), 500);
  }

  setMix(v: number): void {
    this._mix = Math.max(0, Math.min(1, v));
    if (!this._bypassed) {
      this.dryGain.gain.setTargetAtTime(1 - this._mix, this.ctx.currentTime, 0.01);
      this.wetGain.gain.setTargetAtTime(this._mix,     this.ctx.currentTime, 0.01);
    }
  }

  setBypassed(b: boolean): void {
    this._bypassed = b;
    this.dryGain.gain.setTargetAtTime(b ? 1 : 1 - this._mix, this.ctx.currentTime, 0.01);
    this.wetGain.gain.setTargetAtTime(b ? 0 : this._mix,     this.ctx.currentTime, 0.01);
  }

  setBPM(bpm: number): void {
    this._bpm = bpm;
    if (this._synced) this._applyRate();
  }

  setSynced(v: boolean): void {
    this._synced = v;
    this._applyRate();
  }

  setSyncDiv(v: TranceGateSyncDiv): void {
    this._syncDiv = v;
    if (this._synced) this._applyRate();
  }

  private _effectiveRate(): number {
    if (this._synced) return (this._bpm / 60) * (DIV_FACTORS[this._syncDiv] / 4);
    return this._rate;
  }

  private _applyRate(): void {
    this.lfo.frequency.setTargetAtTime(this._effectiveRate(), this.ctx.currentTime, 0.01);
  }

  async init(): Promise<void> { /* native nodes — no worklet needed */ }

  dispose(): void {
    try { this.lfo.stop(); } catch (_) {}
  }

  get rate()     { return this._rate; }
  get depth()    { return this._depth; }
  get attack()   { return this._attack; }
  get release()  { return this._release; }
  get mix()      { return this._mix; }
  get bypassed() { return this._bypassed; }
  get synced()   { return this._synced; }
  get syncDiv()  { return this._syncDiv; }
}
