export class Clipper {
  readonly input: GainNode;
  readonly output: GainNode;
  private preGain: GainNode;
  private shaper: WaveShaperNode;
  private postGain: GainNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private _amount = 0.5;
  private _drive = 0.5;
  private _mix = 0.7;
  private _bypassed = false;

  constructor(ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.preGain = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';
    this.postGain = ctx.createGain();
    this.postGain.gain.value = 0.7; // compensate clipping loudness
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.preGain);
    this.preGain.connect(this.shaper);
    this.shaper.connect(this.postGain);
    this.postGain.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.setDrive(this._drive);
    this.setMix(this._mix);
  }

  private updateCurve(): void {
    const n = 512;
    const curve: Float32Array<ArrayBuffer> = new Float32Array(n);
    // soft: gentle tanh (warm tube); hard: steep tanh (harsh digital brick-wall)
    const kSoft = 2  + this._drive * 4;
    const kHard = 10 + this._drive * 90;
    for (let i = 0; i < n; i++) {
      const x    = (i * 2) / n - 1;
      const soft = Math.tanh(kSoft * x) / Math.tanh(kSoft);
      const hard = Math.tanh(kHard * x) / Math.tanh(kHard);
      curve[i]   = soft * (1 - this._amount) + hard * this._amount;
    }
    this.shaper.curve = curve;
  }

  setAmount(v: number) {
    this._amount = Math.max(0, Math.min(1, v));
    this.updateCurve();
  }

  setDrive(v: number) {
    this._drive = Math.max(0, Math.min(1, v));
    this.preGain.gain.value = 1 + this._drive * 3;
    this.updateCurve();
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

  get amount() { return this._amount; }
  get drive() { return this._drive; }
  get mix() { return this._mix; }
  get bypassed() { return this._bypassed; }
}
