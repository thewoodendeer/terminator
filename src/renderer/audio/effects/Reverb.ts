export class Reverb {
  readonly input: GainNode;
  readonly output: GainNode;
  private convolver: ConvolverNode;
  private preHPF: BiquadFilterNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private _mix = 0.3;
  private _preHPFFreq = 200;
  private _decay = 2.0;
  private _bypassed = false;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.preHPF = ctx.createBiquadFilter();
    this.preHPF.type = 'highpass';
    this.preHPF.frequency.value = this._preHPFFreq;
    this.preHPF.Q.value = 0.5;
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.preHPF);
    this.preHPF.connect(this.convolver);
    this.convolver.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.setMix(this._mix);
    this.rebuildIR();
  }

  private rebuildIR(): void {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * this._decay * 1.2);
    const ir = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let prev = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const env = Math.exp(-4.5 * t / this._decay);
        const noise = (Math.random() * 2 - 1) * env;
        prev = prev * 0.4 + noise * 0.6;
        d[i] = prev * 0.2;
      }
    }
    this.convolver.buffer = ir;
  }

  setDecay(v: number) {
    this._decay = Math.max(0.1, Math.min(10, v));
    this.rebuildIR();
  }

  setPreHPF(freq: number) {
    this._preHPFFreq = Math.max(20, Math.min(2000, freq));
    this.preHPF.frequency.value = this._preHPFFreq;
  }

  setMix(v: number) {
    this._mix = Math.max(0, Math.min(1, v));
    if (!this._bypassed) {
      this.dryGain.gain.value = 1 - this._mix;
      this.wetGain.gain.value = this._mix;
    }
  }

  setBypassed(b: boolean) {
    this._bypassed = b;
    this.dryGain.gain.value = b ? 1 : 1 - this._mix;
    this.wetGain.gain.value = b ? 0 : this._mix;
  }

  get mix() { return this._mix; }
  get decay() { return this._decay; }
  get preHPFFreq() { return this._preHPFFreq; }
  get bypassed() { return this._bypassed; }
}
