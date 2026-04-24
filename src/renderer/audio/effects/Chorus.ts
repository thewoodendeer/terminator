export class Chorus {
  readonly input: GainNode;
  readonly output: GainNode;
  private delay: DelayNode;
  private lfo: OscillatorNode;
  private lfoGain: GainNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private _rate = 2;
  private _depth = 0.004;
  private _mix = 0.35;
  private _bypassed = false;

  constructor(private ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.delay = ctx.createDelay(0.1);
    this.delay.delayTime.value = 0.025;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = this._rate;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = this._depth;
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.delay.delayTime);

    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.delay);
    this.delay.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.setMix(this._mix);
    this.lfo.start();
  }

  setRate(v: number) {
    this._rate = Math.max(0.1, Math.min(10, v));
    this.lfo.frequency.setTargetAtTime(this._rate, this.ctx.currentTime, 0.01);
  }

  setDepth(v: number) {
    this._depth = Math.max(0, Math.min(0.02, v));
    this.lfoGain.gain.setTargetAtTime(this._depth, this.ctx.currentTime, 0.01);
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

  dispose() {
    try { this.lfo.stop(); } catch (_) {}
  }

  get rate() { return this._rate; }
  get depth() { return this._depth; }
  get mix() { return this._mix; }
  get bypassed() { return this._bypassed; }
}
